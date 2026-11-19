//! EC2 commands.

use super::AppState;
use crate::ec2::{self, Instance, InstanceDetails, Interface, Volume};
use crate::ec2_network::{self as network, Address, GroupDetails, SecurityGroup, Subnet, SubnetDetails, Vpc, VpcDetails};
use crate::ec2_templates::{self as templates, KeyPair, LaunchTemplate, TemplateDetails};
use crate::elb::{self, LoadBalancer, LoadBalancerDetails, TargetGroup, TargetGroupDetails, TargetRef};
use crate::ec2_storage::{self as storage, Image, Snapshot, SnapshotDetails};
use crate::ec2_actions::{self as actions, StateChange, TypeInfo};
use crate::ec2_tags::{self as tags, CreatedSnapshot, ImageRequest};
use crate::ec2_console::{self as console, ConsoleOutput, InstanceStatus, SsmAgent, UserData};
use crate::error::AppError;
use tauri::State;

/// Every instance in the region, newest launch first.
#[tauri::command]
pub async fn ec2_instances(state: State<'_, AppState>) -> Result<Vec<Instance>, AppError> {
    ec2::list_instances(&*state.connection()?).await
}

/// One instance with its volumes, interfaces, security groups and protection flags.
#[tauri::command]
pub async fn ec2_instance(state: State<'_, AppState>, id: String) -> Result<InstanceDetails, AppError> {
    ec2::instance_details(&*state.connection()?, &id).await
}

/// Status checks and scheduled events.
#[tauri::command]
pub async fn ec2_status(state: State<'_, AppState>, id: String) -> Result<InstanceStatus, AppError> {
    console::status(&*state.connection()?, &id).await
}

/// Console output (the latest where the instance supports it).
#[tauri::command]
pub async fn ec2_console_output(
    state: State<'_, AppState>,
    id: String,
    latest: bool,
) -> Result<ConsoleOutput, AppError> {
    console::console_output(&*state.connection()?, &id, latest).await
}

/// A screenshot of the instance's console as a data: URL.
#[tauri::command]
pub async fn ec2_screenshot(state: State<'_, AppState>, id: String) -> Result<String, AppError> {
    console::screenshot(&*state.connection()?, &id).await
}

/// User data, decoded. Only on Reveal / Copy; never cached.
#[tauri::command]
pub async fn ec2_user_data(state: State<'_, AppState>, id: String) -> Result<UserData, AppError> {
    console::user_data(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn ec2_start(state: State<'_, AppState>, ids: Vec<String>) -> Result<Vec<StateChange>, AppError> {
    state.ensure_writable()?;
    actions::start(&*state.connection()?, &ids).await
}

#[tauri::command]
pub async fn ec2_stop(
    state: State<'_, AppState>,
    ids: Vec<String>,
    hibernate: bool,
    force: bool,
) -> Result<Vec<StateChange>, AppError> {
    state.ensure_writable()?;
    actions::stop(&*state.connection()?, &ids, hibernate, force).await
}

#[tauri::command]
pub async fn ec2_reboot(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), AppError> {
    state.ensure_writable()?;
    actions::reboot(&*state.connection()?, &ids).await
}

#[tauri::command]
pub async fn ec2_terminate(state: State<'_, AppState>, ids: Vec<String>) -> Result<Vec<StateChange>, AppError> {
    state.ensure_writable()?;
    actions::terminate(&*state.connection()?, &ids).await
}

/// Changes a stopped instance's type.
#[tauri::command]
pub async fn ec2_set_type(state: State<'_, AppState>, id: String, instance_type: String) -> Result<(), AppError> {
    state.ensure_writable()?;
    actions::set_type(&*state.connection()?, &id, &instance_type).await
}

/// Turns termination and / or stop protection on or off (None = unchanged).
#[tauri::command]
pub async fn ec2_set_protection(
    state: State<'_, AppState>,
    id: String,
    termination: Option<bool>,
    stop: Option<bool>,
) -> Result<(), AppError> {
    state.ensure_writable()?;
    actions::set_protection(&*state.connection()?, &id, termination, stop).await
}

/// Instance types offered in an availability zone for an architecture.
#[tauri::command]
pub async fn ec2_instance_types(
    state: State<'_, AppState>,
    az: String,
    architecture: Option<String>,
) -> Result<Vec<TypeInfo>, AppError> {
    actions::instance_types(&*state.connection()?, &az, architecture.as_deref()).await
}

/// Sets a resource's user tags to `desired` (current = what the UI showed).
#[tauri::command]
pub async fn ec2_set_tags(
    state: State<'_, AppState>,
    resource: String,
    current: Vec<(String, String)>,
    desired: Vec<(String, String)>,
) -> Result<(usize, usize), AppError> {
    state.ensure_writable()?;
    tags::set_tags(&*state.connection()?, &resource, &current, &desired).await
}

/// Creates an AMI from an instance; returns its ID.
#[tauri::command]
pub async fn ec2_create_image(state: State<'_, AppState>, request: ImageRequest) -> Result<String, AppError> {
    state.ensure_writable()?;
    tags::create_image(&*state.connection()?, &request).await
}

/// Snapshot of one volume.
#[tauri::command]
pub async fn ec2_snapshot_volume(
    state: State<'_, AppState>,
    volume_id: String,
    description: Option<String>,
    tags: Vec<(String, String)>,
) -> Result<CreatedSnapshot, AppError> {
    state.ensure_writable()?;
    tags::snapshot_volume(&*state.connection()?, &volume_id, description.as_deref(), &tags).await
}

/// Snapshots of all an instance's volumes at the same moment.
#[tauri::command]
pub async fn ec2_snapshot_instance(
    state: State<'_, AppState>,
    instance_id: String,
    description: Option<String>,
    exclude_root: bool,
) -> Result<Vec<CreatedSnapshot>, AppError> {
    state.ensure_writable()?;
    tags::snapshot_instance(&*state.connection()?, &instance_id, description.as_deref(), exclude_root).await
}

/// Whether Systems Manager manages the instance (for Session Manager).
#[tauri::command]
pub async fn ec2_ssm_agent(state: State<'_, AppState>, id: String) -> Result<SsmAgent, AppError> {
    Ok(console::ssm_agent(&*state.connection()?, &id).await)
}

/// Your images ("mine") or images shared with you ("shared").
#[tauri::command]
pub async fn ec2_images(state: State<'_, AppState>, scope: String) -> Result<Vec<Image>, AppError> {
    storage::list_images(&*state.connection()?, &scope).await
}

#[tauri::command]
pub async fn ec2_image(state: State<'_, AppState>, id: String) -> Result<Image, AppError> {
    storage::get_image(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn ec2_volumes(state: State<'_, AppState>) -> Result<Vec<Volume>, AppError> {
    storage::list_volumes(&*state.connection()?).await
}

#[tauri::command]
pub async fn ec2_volume(state: State<'_, AppState>, id: String) -> Result<Volume, AppError> {
    storage::get_volume(&*state.connection()?, &id).await
}

/// Your snapshots.
#[tauri::command]
pub async fn ec2_snapshots(state: State<'_, AppState>) -> Result<Vec<Snapshot>, AppError> {
    storage::list_snapshots(&*state.connection()?).await
}

#[tauri::command]
pub async fn ec2_snapshot(state: State<'_, AppState>, id: String) -> Result<SnapshotDetails, AppError> {
    storage::get_snapshot(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn ec2_security_groups(state: State<'_, AppState>) -> Result<Vec<SecurityGroup>, AppError> {
    network::list_security_groups(&*state.connection()?).await
}

/// A security group with what uses it and which groups reference it.
#[tauri::command]
pub async fn ec2_security_group(state: State<'_, AppState>, id: String) -> Result<GroupDetails, AppError> {
    network::security_group(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn ec2_vpcs(state: State<'_, AppState>) -> Result<Vec<Vpc>, AppError> {
    network::list_vpcs(&*state.connection()?).await
}

#[tauri::command]
pub async fn ec2_vpc(state: State<'_, AppState>, id: String) -> Result<VpcDetails, AppError> {
    network::vpc_details(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn ec2_subnets(state: State<'_, AppState>) -> Result<Vec<Subnet>, AppError> {
    network::list_subnets(&*state.connection()?, None).await
}

#[tauri::command]
pub async fn ec2_subnet(state: State<'_, AppState>, id: String) -> Result<SubnetDetails, AppError> {
    network::subnet_details(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn ec2_interfaces(state: State<'_, AppState>) -> Result<Vec<Interface>, AppError> {
    network::list_interfaces(&*state.connection()?).await
}

#[tauri::command]
pub async fn ec2_interface(state: State<'_, AppState>, id: String) -> Result<Interface, AppError> {
    network::get_interface(&*state.connection()?, &id).await
}

/// Elastic IPs.
#[tauri::command]
pub async fn ec2_addresses(state: State<'_, AppState>) -> Result<Vec<Address>, AppError> {
    network::list_addresses(&*state.connection()?).await
}

/// Key pairs (names, type, fingerprint; never key material).
#[tauri::command]
pub async fn ec2_key_pairs(state: State<'_, AppState>) -> Result<Vec<KeyPair>, AppError> {
    templates::list_key_pairs(&*state.connection()?).await
}

#[tauri::command]
pub async fn ec2_launch_templates(state: State<'_, AppState>) -> Result<Vec<LaunchTemplate>, AppError> {
    templates::list_templates(&*state.connection()?).await
}

/// A launch template with every version's data (user data hidden).
#[tauri::command]
pub async fn ec2_launch_template(state: State<'_, AppState>, id: String) -> Result<TemplateDetails, AppError> {
    templates::template_details(&*state.connection()?, &id).await
}

#[tauri::command]
pub async fn ec2_load_balancers(state: State<'_, AppState>) -> Result<Vec<LoadBalancer>, AppError> {
    elb::list_load_balancers(&*state.connection()?).await
}

/// A load balancer with its listeners, rules, attributes and tags.
#[tauri::command]
pub async fn ec2_load_balancer(state: State<'_, AppState>, name: String) -> Result<LoadBalancerDetails, AppError> {
    elb::load_balancer(&*state.connection()?, &name).await
}

#[tauri::command]
pub async fn ec2_target_groups(state: State<'_, AppState>) -> Result<Vec<TargetGroup>, AppError> {
    elb::list_target_groups(&*state.connection()?).await
}

/// A target group with the health of each target.
#[tauri::command]
pub async fn ec2_target_group(state: State<'_, AppState>, name: String) -> Result<TargetGroupDetails, AppError> {
    elb::target_group(&*state.connection()?, &name).await
}

#[tauri::command]
pub async fn ec2_register_targets(state: State<'_, AppState>, group: String, targets: Vec<TargetRef>) -> Result<(), AppError> {
    state.ensure_writable()?;
    elb::register(&*state.connection()?, &group, &targets).await
}

#[tauri::command]
pub async fn ec2_deregister_targets(state: State<'_, AppState>, group: String, targets: Vec<TargetRef>) -> Result<(), AppError> {
    state.ensure_writable()?;
    elb::deregister(&*state.connection()?, &group, &targets).await
}
