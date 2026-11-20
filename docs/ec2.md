# EC2

Amazon EC2 in the selected region: instances, AMIs, EBS volumes and
snapshots, security groups and networking, key pairs, launch templates,
load balancers and target groups, Auto Scaling groups, and a report of
unused resources. Open **EC2** in the tree under your profile (after
ElastiCache).

EC2 is **regional**: the toolbar's **Region** list applies.

What the app changes, and only with the read-only lock off:

- instances: start, stop (or hibernate), reboot, terminate, change the
  instance type, termination and stop protection;
- tags on any EC2 resource;
- creating an image (AMI) from an instance, and snapshots of an instance's
  volumes or of one volume;
- target groups: register and deregister targets;
- Auto Scaling groups: desired / minimum / maximum capacity, suspend and
  resume processes, start and cancel an instance refresh.

What it doesn't do (agreed scope): launch instances; create or delete load
balancers, listeners, Auto Scaling groups, volumes, security groups or
Elastic IPs; edit security group rules; change an instance's security
groups or IAM role; deregister images or delete snapshots; copy images or
snapshots to other regions; AMI sharing; Windows password decryption;
metrics; costs.

## Overview and tree

The EC2 node opens an overview of every resource kind. In the tree:
**Instances** (expands to the instances the list shows, first 200), **AMIs**,
**Volumes**, **Snapshots**, **Security groups**, **Network** (VPCs, Subnets,
Network interfaces, Elastic IPs), **Key pairs**, **Launch templates**,
**Load balancers**, **Target groups**, **Auto Scaling groups** and **Unused
resources**. Right-click a node for **Add bookmark…**.

Every list loads in full and is shown 100, 500 or 1,000 at a time with a
pager (Ctrl+PgUp / Ctrl+PgDn). The **Filter** box takes part of the name
(the Name tag), the start of an ID, or a tag as `key=value` (the value's
start; `key=` finds resources that have the tag); some lists also match
other IDs (a volume's instance, a snapshot's volume, a subnet's VPC, …).
Press **Enter**; filters are remembered per profile, region and list (the
last 10). Right-click a row to **Open** it, **Copy ID** or **Add bookmark…**.

## Instances

Columns: **Name, Instance ID, State, Type, Zone, Private IP, Public IP,
Launched, Platform, Key pair**, newest launch first. The state buttons
above the list show or hide instances by state; terminated instances are
hidden at first (AWS lists them for about an hour). The choice is
remembered.

Actions (command bar, or right-click; they act on the open instance or the
selected rows):

| Action | Notes |
| --- | --- |
| **Start** | stopped instances; asks first |
| **Stop…** | optional hibernate (only for instances launched with hibernation) and force stop |
| **Reboot** | running instances; asks first |
| **Change type** (Ctrl+E) | one stopped instance; lists the types offered in its zone for its architecture, with vCPUs and memory |
| **Protection** | termination and stop protection (instance view); turning either off asks |
| **Terminate…** (Del) | type the instance ID (or "terminate N instances") to confirm |
| **Create image** | an AMI of the instance, rebooting it first unless you untick that |
| **Snapshot** | one crash-consistent snapshot of every EBS volume, each tagged like its volume |

### Instance view

Tabs:

- **Details**: state, type, platform, vCPUs, image, key pair, purchase
  option, Auto Scaling group (opens it), addresses, IAM role (opens it in
  IAM), instance metadata (IMDSv2), termination and stop protection,
  shutdown behaviour, tags (**Edit tags…**).
- **Storage**: EBS volumes in device order, with size, type, IOPS /
  throughput, encryption and whether each is deleted with the instance;
  **Snapshot…** per volume.
- **Networking**: each network interface's addresses, public IP (auto
  assigned or Elastic IP), subnet, MAC and security groups.
- **Security groups**: each group's inbound and outbound rules, one row per
  source; referenced groups are named and open on click; rules open to
  0.0.0.0/0 or ::/0 are marked.
- **Connect**: commands to copy, with the profile and region filled in:
  Session Manager shell, SSH through Session Manager, port forwarding, SSH
  and EC2 Instance Connect (Linux), or Session Manager, an RDP tunnel and
  `mstsc` (Windows). Above them: whether Systems Manager manages the
  instance (agent online, version), its public address, and whether port 22
  / 3389 is open in its groups. The app never connects itself.
- **Status checks**: system, instance and EBS checks, and scheduled events
  (reboots, retirement, maintenance) with their windows.
- **Console**: **Output** (the serial console text: latest on Nitro
  instances, else the saved buffer; colour codes removed; line numbers and
  wrapping as you like) or **Screenshot** (an image of the screen).
- **User data**: masked until **Reveal** or **Copy**, dropped on Hide or
  when you leave; never saved. Compressed user data shows its size only.

The view checks again every 5 seconds while the instance is starting,
stopping or shutting down.

## AMIs, volumes and snapshots

- **AMIs**: **Mine** or **Shared with me** (images other accounts let yours
  launch; public images aren't listed). An image shows its block devices
  (each snapshot opens) and the instances in this region launched from it.
- **Volumes**: size, type, state (*unattached* volumes are dimmed), what
  they're attached to. A volume opens its attachments, its source snapshot
  and **Create snapshot…**.
- **Snapshots**: yours, newest first, with progress while pending. A
  snapshot shows its volume (marked *deleted* if gone) and the images that
  use it.

## Networking

- **Security groups**: rule counts and the ports open to the internet. A
  group shows its rules, **Used by** (the network interfaces that have it
  and what each belongs to: an instance, load balancer, Lambda function,
  RDS database, …) and **Referenced by** (groups whose rules name it).
- **VPCs**: ranges, subnets, internet and NAT gateways, route tables.
- **Subnets**: zone, range, free addresses, whether instances get public
  IPs, the instances in it, and the route table that applies; *Reaches the
  internet* says whether it routes to an internet gateway.
- **Network interfaces**: every interface and what it belongs to.
- **Elastic IPs**: what each is associated with; idle ones are dimmed.

Every resource view has its tags, with **Edit tags…** (keys starting with
`aws:` are AWS's and can't be changed).

## Key pairs and launch templates

- **Key pairs**: name, type, fingerprint, and the instances launched with
  each. The private key is never available (AWS doesn't keep it).
- **Launch templates**: versions newest first; click one to see its launch
  settings as a tree (AWS CLI field names), **Compare** any two. User data
  in a template shows its size only.

## Load balancers and target groups

- **Load balancers** (application, network, gateway; not Classic): DNS name
  to copy, zones and subnets, security groups, main settings, and each
  listener. Application load balancers list their rules in priority order
  as sentences ("path is /api/\*" → "forward to api-tg (80), canary
  (20)"); target groups open on click.
- **Target groups**: health check and each target's health with the
  reason. **Register targets…** (instances in the group's VPC, or IP
  addresses) and **Deregister selected…**. The view re-checks every 10
  seconds while targets are initial or draining.

## Auto Scaling groups

Capacity, launch template (opens it), subnets, target groups, health check,
suspended processes, scaling policies, instances (lifecycle and health),
instance refreshes and the 50 newest activities. **Set capacity…**,
**Suspend / resume…** (tick the processes to suspend) and **Start instance
refresh…** (minimum healthy %, warm-up, skip matching) / **Cancel instance
refresh…**.

## Unused resources

Unattached volumes, Elastic IPs not associated with anything, security
groups no network interface uses (default groups excluded), snapshots
whose volume is gone and that no image of yours uses, and images no
instance in the region was launched from. Filter by kind, open a row, or
**Export CSV… / JSON…** (a local file; allowed in read-only mode). Parts the
profile can't read are named at the top and left out. The app deletes
nothing.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Enter | Open the selected resource |
| Del | Terminate the open or selected instances |
| Ctrl+E | Change the instance type |
| Ctrl+PgUp / Ctrl+PgDn | Previous / next page |
| F5 | Refresh |

## History

Every change (instance actions, tags, images, snapshots, targets, Auto
Scaling) is recorded in the activity history with what it acted on; the
unused-resources export is too. Values (user data, tag values) aren't
recorded, only names and keys.

## Permissions

Reads (the AWS managed policy `AmazonEC2ReadOnlyAccess` covers the EC2,
Elastic Load Balancing and Auto Scaling ones):

- EC2: `ec2:DescribeInstances`, `ec2:DescribeInstanceAttribute`,
  `ec2:DescribeInstanceStatus`, `ec2:DescribeInstanceTypes`,
  `ec2:DescribeInstanceTypeOfferings`, `ec2:GetConsoleOutput`,
  `ec2:GetConsoleScreenshot`, `ec2:DescribeVolumes`, `ec2:DescribeSnapshots`,
  `ec2:DescribeImages`, `ec2:DescribeSecurityGroups`,
  `ec2:DescribeNetworkInterfaces`, `ec2:DescribeVpcs`,
  `ec2:DescribeSubnets`, `ec2:DescribeRouteTables`,
  `ec2:DescribeInternetGateways`, `ec2:DescribeNatGateways`,
  `ec2:DescribeAddresses`, `ec2:DescribeKeyPairs`,
  `ec2:DescribeLaunchTemplates`, `ec2:DescribeLaunchTemplateVersions`
- Elastic Load Balancing: `elasticloadbalancing:DescribeLoadBalancers`,
  `DescribeLoadBalancerAttributes`, `DescribeListeners`, `DescribeRules`,
  `DescribeTargetGroups`, `DescribeTargetGroupAttributes`,
  `DescribeTargetHealth`, `DescribeTags`
- Auto Scaling: `autoscaling:DescribeAutoScalingGroups`,
  `DescribeScalingActivities`, `DescribeInstanceRefreshes`,
  `DescribePolicies`
- Optional: `iam:GetInstanceProfile` (an instance's role) and
  `ssm:DescribeInstanceInformation` (the Connect tab's agent check)

Changes: `ec2:StartInstances`, `ec2:StopInstances`, `ec2:RebootInstances`,
`ec2:TerminateInstances`, `ec2:ModifyInstanceAttribute`,
`ec2:CreateTags`, `ec2:DeleteTags`, `ec2:CreateImage`,
`ec2:CreateSnapshot`, `ec2:CreateSnapshots`,
`elasticloadbalancing:RegisterTargets`,
`elasticloadbalancing:DeregisterTargets`,
`autoscaling:UpdateAutoScalingGroup`, `autoscaling:SuspendProcesses`,
`autoscaling:ResumeProcesses`, `autoscaling:StartInstanceRefresh`,
`autoscaling:CancelInstanceRefresh`.

## Emulators

Works with [MiniStack](https://github.com/ministackorg/ministack) for
browsing, instance lifecycle, tags, snapshots, load balancers (including
registering targets), Auto Scaling and the unused report (the app's
emulator tests use it). MiniStack has no `ModifyInstanceAttribute` or
`CreateImage`, so changing the instance type or protection and creating an
image say the endpoint doesn't support them. Session Manager and EC2
Instance Connect only work against real AWS.
