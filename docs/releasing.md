# Publishing a release

In the commands below, replace `x.y.z` with the new version, such as `0.2.0`.
A release has two parts: GitHub builds and publishes the files, then you submit
the new version to winget by hand.

## 1. Choose a version

Use `MAJOR.MINOR.PATCH`: raise PATCH for fixes, MINOR for new features and MAJOR
for breaking changes. A version can only be released once.

## 2. Set the version

Skip this step only if the files already have the version you're releasing.

1. Make sure `main` is up to date and has no uncommitted work:

   ```bash
   git switch main
   git pull
   git status
   ```

2. Change the version in all three files:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml` (the `version` under `[package]`)

3. Update the lockfiles:

   ```bash
   npm install
   cd src-tauri && cargo check && cd ..
   ```

4. Commit and push:

   ```bash
   git add -A
   git commit -m "Release x.y.z"
   git push
   ```

## 3. Start the build

Create the release branch on GitHub from `main`. This is what starts the workflow:

```bash
git push origin main:refs/heads/release_x.y.z
```

Watch it run (about 15 to 30 minutes), or use the repo's **Actions** tab:

```bash
gh run watch
```

## 4. Check the release

On the repo's **Releases** page, confirm `vx.y.z` has these files:

| File | Purpose |
|---|---|
| `nimbus-explorer_x.y.z_x64-setup.exe` | Installer, also used by winget |
| `nimbus-explorer_x.y.z_x64.exe` | Standalone app; runs without installing |
| `SHA256SUMS.txt` | Checksums |

Download the installer, install it and open the app. Then edit the release notes
if you want to. The builds are unsigned, so Windows shows "Windows protected your
PC"; choose **More info → Run anyway**.

## 5. Submit to winget

Install the tool once:

```bash
winget install Microsoft.WingetCreate
```

If a browser opens during submission, sign in to GitHub and approve access. The
tool creates a fork of `microsoft/winget-pkgs` on your account for its pull request.

### First release only

```bash
wingetcreate new https://github.com/mmeany/nimbus-explorer/releases/download/vx.y.z/nimbus-explorer_x.y.z_x64-setup.exe
```

Answer the prompts, checking the values it pre-fills:

| Field | Value |
|---|---|
| PackageIdentifier | `MarkMeany.NimbusExplorer` |
| Publisher | `Mark Meany` |
| PackageName | `Nimbus Explorer` |
| License | `MIT` |
| ShortDescription | `Explorer-style desktop app that works with Amazon Web Services` |

Answer yes when it asks to submit. The identifier is hard to change later.

### Every later release

```bash
wingetcreate update MarkMeany.NimbusExplorer -v x.y.z -u https://github.com/mmeany/nimbus-explorer/releases/download/vx.y.z/nimbus-explorer_x.y.z_x64-setup.exe --submit
```

Wait until the previous version's pull request has merged before you submit a
new one.

## 6. Follow the winget pull request

The tool opens a pull request on `microsoft/winget-pkgs`. Automated checks run,
then a moderator reviews it. This can take a few days.

- On your first pull request, follow the bot's instructions to sign the
  Contributor License Agreement.
- If it's labelled `Needs-Author-Feedback`, read the comment and respond within
  10 days, or it's closed.

Once it's merged and the catalog has updated, check it:

```bash
winget install MarkMeany.NimbusExplorer
```

## If something goes wrong

| Problem | What to do |
|---|---|
| "Branch is not named release_x.y.z" | Delete the branch and create it with the correct name |
| "Branch says x.y.z, but…" | Delete the branch, redo step 2, then step 3 |
| "Tag vx.y.z already exists" | That version is already out, so use a new version |
| Temporary failure, such as a network error | Open the failed run in **Actions** and choose **Re-run failed jobs** |
| Tests, audit or build failed | Fix it on `main`, delete the branch, then repeat step 3 |
| The published release has a bug | Don't replace its files, because winget checks their hashes. Fix it and release a new version |

To delete the branch:

```bash
git push origin --delete release_x.y.z
```

Pushing more commits to an existing release branch doesn't start a new build. The
workflow only runs when the branch is created.
