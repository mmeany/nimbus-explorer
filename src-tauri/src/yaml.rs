//! YAML → JSON for the preview tree. The browser has no YAML parser, so the
//! backend does it.
//!
//! We drive yaml-rust2's event parser ourselves instead of using its loader,
//! because the loader expands aliases by copying them eagerly: a few hundred
//! bytes of crafted YAML ("billion laughs") could exhaust memory. Here every
//! node, including each alias's full expanded size, counts against a budget.

use serde_json::{Map, Number, Value};
use std::collections::HashMap;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};
use yaml_rust2::Yaml;

/// Maximum nodes (after alias expansion) we'll build for a preview.
pub const MAX_NODES: usize = 1_000_000;

enum Frame {
    Seq {
        items: Vec<Value>,
        anchor: usize,
        start: usize,
    },
    Map {
        map: Map<String, Value>,
        key: Option<String>,
        anchor: usize,
        start: usize,
    },
}

#[derive(Default)]
struct Builder {
    stack: Vec<Frame>,
    docs: Vec<Value>,
    /// anchor id -> (value, node count)
    anchors: HashMap<usize, (Value, usize)>,
    nodes: usize,
    error: Option<String>,
}

impl Builder {
    fn count(&mut self, n: usize) -> bool {
        self.nodes += n;
        if self.nodes > MAX_NODES {
            self.error = Some(format!(
                "This YAML expands to more than {MAX_NODES} nodes (possibly through aliases), so it can't be shown as a tree."
            ));
            false
        } else {
            true
        }
    }

    fn push(&mut self, value: Value) {
        match self.stack.last_mut() {
            None => self.docs.push(value),
            Some(Frame::Seq { items, .. }) => items.push(value),
            Some(Frame::Map { map, key, .. }) => match key.take() {
                None => *key = Some(key_string(value)),
                Some(k) => {
                    map.insert(k, value);
                }
            },
        }
    }

    fn finish(&mut self, value: Value, anchor: usize, start: usize) {
        if anchor > 0 {
            self.anchors
                .insert(anchor, (value.clone(), self.nodes - start));
        }
        self.push(value);
    }
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, ev: Event, _mark: Marker) {
        if self.error.is_some() {
            return;
        }
        match ev {
            Event::Scalar(text, style, anchor, tag) => {
                if !self.count(1) {
                    return;
                }
                let start = self.nodes - 1;
                self.finish(scalar(text, style, tag.as_ref()), anchor, start);
            }
            Event::SequenceStart(anchor, _) => {
                if self.count(1) {
                    self.stack.push(Frame::Seq {
                        items: Vec::new(),
                        anchor,
                        start: self.nodes - 1,
                    });
                }
            }
            Event::MappingStart(anchor, _) => {
                if self.count(1) {
                    self.stack.push(Frame::Map {
                        map: Map::new(),
                        key: None,
                        anchor,
                        start: self.nodes - 1,
                    });
                }
            }
            Event::SequenceEnd => {
                if let Some(Frame::Seq {
                    items,
                    anchor,
                    start,
                }) = self.stack.pop()
                {
                    self.finish(Value::Array(items), anchor, start);
                }
            }
            Event::MappingEnd => {
                if let Some(Frame::Map {
                    map, anchor, start, ..
                }) = self.stack.pop()
                {
                    self.finish(Value::Object(map), anchor, start);
                }
            }
            Event::Alias(id) => {
                let found = self.anchors.get(&id).map(|(_, n)| *n);
                match found {
                    // Check the budget BEFORE cloning.
                    Some(n) => {
                        if self.count(n) {
                            let v = self.anchors[&id].0.clone();
                            self.push(v);
                        }
                    }
                    None => self.push(Value::Null),
                }
            }
            _ => {}
        }
    }
}

/// Resolves a scalar like YAML 1.2 core schema: quoted/`!!str` stay strings;
/// plain scalars may be null, booleans or numbers.
fn scalar(text: String, style: TScalarStyle, tag: Option<&Tag>) -> Value {
    if style != TScalarStyle::Plain || tag.is_some_and(|t| t.suffix == "str") {
        return Value::String(text);
    }
    match Yaml::from_str(&text) {
        Yaml::Integer(i) => Value::Number(i.into()),
        Yaml::Real(r) => r
            .parse::<f64>()
            .ok()
            .and_then(Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::String(text)),
        Yaml::Boolean(b) => Value::Bool(b),
        Yaml::Null => Value::Null,
        _ => Value::String(text),
    }
}

/// Map keys must be strings in JSON; non-string keys use their JSON text.
fn key_string(v: Value) -> String {
    match v {
        Value::String(s) => s,
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// Parses a YAML stream into one JSON value per document.
pub fn parse(text: &str) -> Result<Vec<Value>, String> {
    let mut b = Builder::default();
    Parser::new_from_str(text)
        .load(&mut b, true)
        .map_err(|e| e.to_string())?;
    match b.error {
        Some(e) => Err(e),
        None => Ok(b.docs),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_types_and_keeps_order() {
        let docs = parse("zeta: 1\nalpha: 2.5\nflag: true\nnone: ~\nquoted: '42'\nlist: [a, b]\nnested:\n  x: y\n").unwrap();
        assert_eq!(docs.len(), 1);
        let v = &docs[0];
        assert_eq!(
            v,
            &json!({"zeta": 1, "alpha": 2.5, "flag": true, "none": null, "quoted": "42", "list": ["a", "b"], "nested": {"x": "y"}})
        );
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys[0], "zeta", "document order preserved");
    }

    #[test]
    fn handles_multiple_documents_aliases_and_odd_keys() {
        let docs = parse("a: &x {k: 1}\nb: *x\n---\n1: one\n? [p, q]\n: pair\n").unwrap();
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0], json!({"a": {"k": 1}, "b": {"k": 1}}));
        assert_eq!(docs[1], json!({"1": "one", "[\"p\",\"q\"]": "pair"}));
    }

    #[test]
    fn rejects_billion_laughs() {
        let mut y = String::from("a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n");
        for i in 1..12 {
            let refs = vec![format!("*a{}", i - 1); 10].join(", ");
            y.push_str(&format!("a{i}: &a{i} [{refs}]\n"));
        }
        let err = parse(&y).unwrap_err();
        assert!(err.contains("more than"), "{err}");
    }

    #[test]
    fn reports_syntax_errors() {
        assert!(parse("a: [unclosed\n").is_err());
    }
}
