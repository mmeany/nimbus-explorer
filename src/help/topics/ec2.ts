import type { Ec2Kind } from "../../shell/places";

export const ec2Topics = {
  "ec2.overview": {
    title: "EC2",
    body: `The region's EC2 resources, one list per kind. Open a kind to list it; the tree shows the same kinds under **EC2**. EC2 is regional: the region switcher in the toolbar applies.

What the app changes in EC2 is limited on purpose: instance state, instance type, tags, termination and stop protection, and creating images and snapshots. It doesn't launch instances or edit security group rules.`,
  },
  "ec2.instances": {
    title: "Instances",
    body: `Every instance in the region, newest launch first.

- **States**: click a state to show or hide its instances. Terminated instances are hidden at first; AWS lists them for about an hour after they end. Your choice is remembered.
- **Filter**: part of the Name tag, the start of an instance ID, or a tag as *key=value* (the value's start; *key=* finds instances that have the tag at all). Press Enter; previous filters are remembered for this profile and region.
- **Open** an instance: Enter or double-click. Right-click for actions, copying its ID or addresses, and bookmarks.
- **Actions** (command bar or right-click) work on the selected instances: **Start**, **Stop…**, **Reboot**, **Change type** (one stopped instance, Ctrl+E) and **Terminate…** (Del). Each asks first; terminating needs the instance ID (or, for several, the phrase shown) typed in. Read-only mode disables them all.

The tree under **Instances** shows the same filtered list (the first 200).`,
  },
  "ec2.instance": {
    title: "Instance details",
    body: `One instance: its state, type, platform, image, key pair, purchase option, Auto Scaling group, addresses, IAM role, instance metadata settings, protection settings and tags. While the instance is starting or stopping, the view checks again every 5 seconds.

- **IAM role**: the role in the instance's instance profile. A role in this account opens in IAM.
- **Instance metadata**: *IMDSv2 only* means software on the instance must use session tokens, which is the safer setting.
- **Termination / stop protection**: when on, the instance can't be terminated or stopped through the API until it's turned off.
- **Public IP**: an auto-assigned public address changes every time the instance stops and starts; an Elastic IP stays.

The command bar acts on this instance: Start, Stop…, Reboot, Change type (when stopped), **Protection**, Terminate…, **Create image** and **Snapshot** (all its volumes). **Edit tags…** is by the Tags section; on the Storage tab, **Snapshot…** snapshots one volume.`,
  },
  "ec2.instance.storage": {
    title: "Instance storage",
    body: `The EBS volumes attached to the instance, in device order, with size, type, performance, encryption and whether each volume is deleted when the instance is terminated. *(root)* marks the boot volume.

Instance store volumes (temporary disks on the host) aren't listed: their data is lost when the instance stops.`,
  },
  "ec2.instance.networking": {
    title: "Instance networking",
    body: `The instance's network interfaces, by device number: private addresses (and the public address mapped to each), DNS names, IPv6 addresses, subnet, MAC address and security groups.

An *auto-assigned* public IP is released when the instance stops; an *Elastic IP* stays with the interface. Click a security group to open it.`,
  },
  "ec2.instance.security": {
    title: "Instance security groups",
    body: `The rules of each security group on the instance. Inbound rules say who may connect to the instance; outbound rules say where it may connect to. Security groups only allow: a connection is permitted if any rule of any of the instance's groups allows it, and replies to allowed connections are always let through.

- A source that is another security group means "any resource that has that group". Click it to open the group.
- **open to the internet** marks inbound rules from 0.0.0.0/0 or ::/0.`,
  },
  "ec2.instance.connect": {
    title: "Connect",
    body: `Commands for reaching the instance from your own machine, with this profile and region filled in. The app itself never connects; copy a command into a terminal.

- **Session Manager** (shell, SSH, port forwarding, Remote Desktop): goes through AWS Systems Manager, so no inbound port has to be open and private instances work. Needs the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) for the AWS CLI, and the instance must be *managed*: running the SSM agent, with a role that allows Systems Manager. The top of the tab says whether it is.
- **SSH / Remote Desktop over the internet**: needs a public address and the port (22 or 3389) open to your address in a security group.
- **EC2 Instance Connect**: sends a one-time key, so no key pair is needed. Private instances go through an Instance Connect Endpoint in the VPC.

The SSH user depends on the image (ec2-user, ubuntu, admin, …); the commands guess from the platform.`,
  },
  "ec2.instance.status": {
    title: "Status checks",
    body: `AWS's health checks for a running instance, and maintenance it has scheduled.

- **System**: problems on AWS's side (the host, its power or network). Stopping and starting the instance (not rebooting) moves it to a healthy host.
- **Instance**: problems inside the instance, such as an OS that didn't boot or a broken network setup. The **Console** tab usually shows why.
- **Attached EBS**: the instance can't reach its EBS volumes.
- **Scheduled events**: reboots, maintenance, retirement or stops that AWS has planned, with the window they'll happen in. Some can be rescheduled until the date shown.

New instances show *initializing* for a few minutes; the tab checks again every 15 seconds meanwhile.`,
  },
  "ec2.instance.console": {
    title: "Console",
    body: `What the instance has written to its serial console, or a picture of its screen. Both help when an instance doesn't boot or can't be reached.

- **Output**: the console text (boot messages, kernel errors, cloud-init progress). Instances built on the Nitro system return the latest output; older types return the buffer AWS saved at boot and on stop. Colour codes are removed. **Copy** copies it all.
- **Screenshot**: a JPEG of the screen, as a monitor would show it. Useful for Windows instances and stuck boot menus. The instance must be running.

Your choice of Output or Screenshot is remembered.`,
  },
  "ec2.instance.userdata": {
    title: "User data",
    body: `The script or cloud-init configuration passed to the instance at launch. It often holds passwords, tokens or keys, so it stays masked until you choose **Reveal** or **Copy**, and it's dropped again when you hide it or leave the tab. The app never saves it.

Plain JSON user data can be viewed as a tree; anything else (scripts, cloud-init) shows as text. Compressed (gzip) user data can't be shown: only its size is.`,
  },
  "ec2.instance.stop": {
    title: "Stop instances",
    body: `Shuts the instances down. Their EBS volumes keep their data and still cost money; the instances themselves don't while stopped. Instance store disks are wiped, and an auto-assigned public IP is released (the next start gets a new one).

- **Hibernate**: saves memory to the root volume so programs carry on where they were at the next start. Only for instances launched with hibernation configured.
- **Force stop**: for an instance stuck in *stopping*. The OS gets no chance to shut down cleanly, so unsaved data is lost.

Spot instances can only be stopped when their request is persistent.`,
  },
  "ec2.instance.type": {
    title: "Change instance type",
    body: `Gives a stopped instance more (or less) CPU and memory. The list shows the types offered in the instance's availability zone for its architecture, the current family first; search to find others, including older generations, or type a type into the box on the right.

The new type must support the instance's image and settings (architecture, virtualization, ENA networking, any EBS optimisation or hibernation). If it doesn't, AWS refuses and the instance keeps its type. Start the instance afterwards to use it.`,
  },
  "ec2.images": {
    title: "AMIs",
    body: `Machine images in this region, newest first.

- **Mine**: images your account owns. **Shared with me**: images other accounts have given yours permission to launch (public images aren't listed). The choice is remembered.
- **Filter**: part of the name, the start of the image ID, or a tag as *key=value*. Previous filters are remembered.
- Images that aren't *available* (pending, failed, disabled) are dimmed.

Open an image to see its block devices (with their snapshots) and which instances were launched from it.`,
  },
  "ec2.image": {
    title: "AMI",
    body: `An image: its owner, platform, architecture, root device and boot settings, the block devices it creates (each EBS one from a snapshot: click to open it), and the running or stopped instances in this region launched from it. While the image is *pending* the view checks again every 15 seconds.

**Edit tags…** changes the image's tags (only the owner can).`,
  },
  "ec2.volumes": {
    title: "Volumes",
    body: `Every EBS volume in the region, newest first, with its size, type, state and the instance it's attached to.

- *unattached* volumes (dimmed) aren't in use but still cost money every month.
- **Filter**: name, the start of the volume ID, an instance ID (volumes attached to it), or a tag as *key=value*.`,
  },
  "ec2.volume": {
    title: "Volume",
    body: `One EBS volume: size, type, performance, zone, encryption, the snapshot it was created from, and what it's attached to (click an instance to open it).

- **Create snapshot…**: a point-in-time copy of the volume.
- **Edit tags…**: change the volume's tags.`,
  },
  "ec2.snapshots": {
    title: "Snapshots",
    body: `Your EBS snapshots in this region, newest first. Snapshots still being taken show their progress and are dimmed.

**Filter**: name, the start of the snapshot ID or of its volume's ID, words from the description, or a tag as *key=value*.`,
  },
  "ec2.snapshot": {
    title: "Snapshot",
    body: `One EBS snapshot: size, when it was taken, the volume it came from (marked *deleted* if that volume is gone), encryption, storage tier, and which of your images use it. *Archive* tier snapshots are cheaper to keep but must be restored before they can be used.

**Edit tags…** changes the snapshot's tags.`,
  },
  "ec2.securityGroups": {
    title: "Security groups",
    body: `Every security group in the region, with how many inbound and outbound rules it has and which ports it opens to the whole internet (0.0.0.0/0 or ::/0).

**Filter**: part of the group name, the start of the group or VPC ID, or a tag as *key=value*. The app shows rules but doesn't change them.`,
  },
  "ec2.securityGroup": {
    title: "Security group",
    body: `One group's inbound and outbound rules, one row per source or destination. A source that is another group means "anything that has that group"; click it to open the group.

- **Used by**: the network interfaces that have this group, and what each belongs to (an instance, a load balancer, a Lambda function, …). None means the group is unused.
- **Referenced by**: groups whose rules name this one; they'd break if it were deleted.`,
  },
  "ec2.vpcs": {
    title: "VPCs",
    body: `The region's virtual private clouds with their address ranges. The default VPC (if there is one) is listed first.`,
  },
  "ec2.vpc": {
    title: "VPC",
    body: `One VPC: its address ranges, subnets (click one to open it), internet and NAT gateways, and route tables. The *main* route table applies to every subnet that doesn't have its own.

A subnet whose route table sends 0.0.0.0/0 to an internet gateway (igw-…) is *public*; one that sends it to a NAT gateway can reach out but can't be reached.`,
  },
  "ec2.subnets": {
    title: "Subnets",
    body: `Every subnet in the region with its VPC, zone, address range and free addresses. **Filter** also matches the start of a VPC ID or CIDR.`,
  },
  "ec2.subnet": {
    title: "Subnet",
    body: `One subnet: its zone, ranges, free addresses, whether new instances get public IPs, the instances in it, and the route table that applies (its own, or the VPC's main table). *Reaches the internet* says whether the routes go to an internet gateway.`,
  },
  "ec2.interfaces": {
    title: "Network interfaces",
    body: `Every network interface in the region and what it belongs to: an instance, or a service such as a load balancer, NAT gateway, Lambda function or RDS database. *available* interfaces (dimmed) aren't attached to anything.

**Filter** also matches the start of an instance, subnet or VPC ID, or an IP address.`,
  },
  "ec2.interface": {
    title: "Network interface",
    body: `One network interface: what it's attached to, its private and public addresses, subnet, security groups and settings. Interfaces *managed by a service* are changed through that service, not EC2.`,
  },
  "ec2.addresses": {
    title: "Elastic IPs",
    body: `Static public IPv4 addresses allocated to your account, and what each is associated with. An Elastic IP that isn't associated (dimmed) is charged by the hour; so is every public IPv4 address in use.`,
  },
  "ec2.keyPairs": {
    title: "Key pairs",
    body: `SSH key pairs registered in this region: name, type, fingerprint and how many instances (not terminated) were launched with each. Key pairs no instance uses are dimmed.

AWS keeps only the public key; the private key was downloaded once, when the pair was created. Neither AWS nor this app can show or recover it. Open a key pair to see the instances that use it.`,
  },
  "ec2.launchTemplates": {
    title: "Launch templates",
    body: `Saved launch settings (image, type, network, storage, tags, …) that Auto Scaling groups and people launching instances can use, with their default and latest version numbers.`,
  },
  "ec2.launchTemplate": {
    title: "Launch template",
    body: `One launch template and its versions, newest first. Click a version to see its launch settings as a tree (Text for JSON); the default version is shown first.

- **Compare**: shows what changed between two versions (from the older to the newer).
- User data is never shown, only its size, since it often holds secrets.
- Settings are shown with the AWS CLI's names; a few rarely used ones aren't mapped.`,
  },
  "ec2.tags": {
    title: "Tags",
    body: `Key / value labels on an EC2 resource. Edit, add or remove rows and **Save**: new and changed tags are set, removed ones deleted, the rest left alone.

- The **Name** tag is what the lists and the tree show.
- Keys are case-sensitive, up to 128 characters; values up to 256; at most 50 tags.
- Tags starting with *aws:* are set by AWS (CloudFormation, Auto Scaling, …) and can't be changed; they're listed greyed out.`,
  },
  "ec2.image.create": {
    title: "Create image",
    body: `Makes an AMI from the instance: a snapshot of each of its EBS volumes plus the launch settings, so you can launch copies later or keep a restore point.

- **Reboot first** (default): AWS shuts the OS down briefly so every file is closed; the image is consistent. Without it the instance keeps running, but files being written may be incomplete.
- **Tag with Name**: sets Name on the image and its snapshots, so they're easy to find.

The image appears under AMIs as *pending* and becomes *available* after a few minutes. It costs money (its snapshots) until you deregister it and delete the snapshots.`,
  },
  "ec2.snapshot.create": {
    title: "Create snapshots",
    body: `A point-in-time copy of EBS volumes, stored in your account.

- **From an instance**: one snapshot of each volume, all taken at the same instant (crash-consistent: as if the power were cut, so files being written may be incomplete). Each snapshot copies its volume's tags. You can leave out the root volume.
- **From a volume** (Snapshot… on the Storage tab): one snapshot of that volume.

Snapshots show under **Snapshots** as *pending* until complete; the volumes stay in use meanwhile. They cost money until you delete them.`,
  },
  "ec2.instance.protection": {
    title: "Instance protection",
    body: `- **Termination protection**: AWS refuses to terminate the instance through the API or console until it's turned off.
- **Stop protection**: the same for stopping and hibernating.

Turning either off asks first. Neither prevents a shutdown from inside the operating system (which stops or terminates the instance, as its shutdown behaviour says), or an Auto Scaling group replacing it.`,
  },
};

type Ec2TopicId = keyof typeof ec2Topics;

/** The topic for an EC2 place. */
export function ec2PlaceTopic(kind: Ec2Kind | null, id: string | null): Ec2TopicId {
  if (kind === "instances") return id ? "ec2.instance" : "ec2.instances";
  if (kind === "images") return id ? "ec2.image" : "ec2.images";
  if (kind === "volumes") return id ? "ec2.volume" : "ec2.volumes";
  if (kind === "snapshots") return id ? "ec2.snapshot" : "ec2.snapshots";
  if (kind === "securityGroups") return id ? "ec2.securityGroup" : "ec2.securityGroups";
  if (kind === "vpcs") return id ? "ec2.vpc" : "ec2.vpcs";
  if (kind === "subnets") return id ? "ec2.subnet" : "ec2.subnets";
  if (kind === "interfaces") return id ? "ec2.interface" : "ec2.interfaces";
  if (kind === "addresses") return "ec2.addresses";
  if (kind === "keyPairs") return "ec2.keyPairs";
  if (kind === "launchTemplates") return id ? "ec2.launchTemplate" : "ec2.launchTemplates";
  return "ec2.overview";
}
