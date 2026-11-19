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
- **Open** an instance: Enter or double-click. Right-click for copying its ID or addresses and for bookmarks.

The tree under **Instances** shows the same filtered list (the first 200).`,
  },
  "ec2.instance": {
    title: "Instance details",
    body: `One instance: its state, type, platform, image, key pair, purchase option, Auto Scaling group, addresses, IAM role, instance metadata settings, protection settings and tags. While the instance is starting or stopping, the view checks again every 5 seconds.

- **IAM role**: the role in the instance's instance profile. A role in this account opens in IAM.
- **Instance metadata**: *IMDSv2 only* means software on the instance must use session tokens, which is the safer setting.
- **Termination / stop protection**: when on, the instance can't be terminated or stopped through the API until it's turned off.
- **Public IP**: an auto-assigned public address changes every time the instance stops and starts; an Elastic IP stays.`,
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
};

type Ec2TopicId = keyof typeof ec2Topics;

/** The topic for an EC2 place. */
export function ec2PlaceTopic(kind: Ec2Kind | null, id: string | null): Ec2TopicId {
  if (kind === "instances") return id ? "ec2.instance" : "ec2.instances";
  return "ec2.overview";
}
