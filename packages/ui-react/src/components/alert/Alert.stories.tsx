import type { Meta, StoryObj } from "@storybook/react-vite";
import { Sparkles, Wifi, X } from "lucide-react";
import { fn } from "storybook/test";
import { Button } from "../button/Button";
import { IconButton } from "../icon-button/IconButton";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  type AlertVariant,
} from "./Alert";

const variants = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
] as const satisfies ReadonlyArray<AlertVariant>;

const copy: Record<AlertVariant, { title: string; description: string }> = {
  danger: {
    description: "Check your connection and try again.",
    title: "Couldn't save changes",
  },
  info: {
    description: "Version 2.4 is ready to install.",
    title: "Update available",
  },
  neutral: {
    description: "Changes apply to every member of this workspace.",
    title: "Heads up",
  },
  success: {
    description: "Your invoice was emailed to the billing contact.",
    title: "Payment received",
  },
  warning: {
    description: "You've used 90% of your storage.",
    title: "Running low on space",
  },
};

const meta = {
  args: {
    variant: "neutral",
  },
  argTypes: {
    icon: { control: false },
    variant: { control: "select", options: variants },
  },
  component: Alert,
  decorators: [
    (Story) => (
      <div style={{ width: 420 }}>
        <Story />
      </div>
    ),
  ],
  title: "Feedback/Alert",
} satisfies Meta<typeof Alert>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => (
    <Alert {...args}>
      <AlertTitle>{copy[args.variant ?? "neutral"].title}</AlertTitle>
      <AlertDescription>
        {copy[args.variant ?? "neutral"].description}
      </AlertDescription>
    </Alert>
  ),
};

export const Variants: Story = {
  render: (args) => (
    <div style={{ display: "grid", gap: 12 }}>
      {variants.map((variant) => (
        <Alert {...args} key={variant} variant={variant}>
          <AlertTitle>{copy[variant].title}</AlertTitle>
          <AlertDescription>{copy[variant].description}</AlertDescription>
        </Alert>
      ))}
    </div>
  ),
};

export const TitleOnly: Story = {
  render: (args) => (
    <div style={{ display: "grid", gap: 12 }}>
      <Alert {...args} variant="info">
        <AlertTitle>Sync paused while you're offline.</AlertTitle>
      </Alert>
      <Alert {...args} variant="success">
        <AlertTitle>All checks passed.</AlertTitle>
      </Alert>
    </div>
  ),
};

export const DescriptionOnly: Story = {
  render: (args) => (
    <Alert {...args}>
      <AlertDescription>
        Imported files keep their original names. You can rename them later from
        the file list.
      </AlertDescription>
    </Alert>
  ),
};

export const WithActions: Story = {
  args: { variant: "info" },
  render: (args) => (
    <div style={{ display: "grid", gap: 12 }}>
      <Alert {...args}>
        <AlertTitle>Update available</AlertTitle>
        <AlertDescription>Restart to finish installing 2.4.</AlertDescription>
        <AlertActions>
          <Button onClick={fn()} size="sm" variant="ghost">
            Later
          </Button>
          <Button onClick={fn()} size="sm">
            Restart
          </Button>
        </AlertActions>
      </Alert>
      <Alert {...args} variant="danger">
        <AlertTitle>Couldn't reach the server.</AlertTitle>
        <AlertActions>
          <Button onClick={fn()} size="sm" variant="danger-soft">
            Retry
          </Button>
        </AlertActions>
      </Alert>
      <Alert {...args} variant="warning">
        <AlertDescription>Some changes haven't synced yet.</AlertDescription>
        <AlertActions>
          <IconButton label="Dismiss" onClick={fn()} size="sm" variant="ghost">
            <X />
          </IconButton>
        </AlertActions>
      </Alert>
    </div>
  ),
};

export const CustomIcon: Story = {
  render: (args) => (
    <div style={{ display: "grid", gap: 12 }}>
      <Alert {...args} icon={<Sparkles />}>
        <AlertTitle>New: keyboard shortcuts</AlertTitle>
        <AlertDescription>
          Press ? anywhere to see the full list.
        </AlertDescription>
      </Alert>
      <Alert {...args} icon={<Wifi />} variant="warning">
        <AlertTitle>Unstable connection</AlertTitle>
        <AlertDescription>
          Some changes may take longer to sync.
        </AlertDescription>
      </Alert>
    </div>
  ),
};

export const WithoutIcon: Story = {
  args: { icon: null },
  render: (args) => (
    <Alert {...args}>
      <AlertTitle>Maintenance window</AlertTitle>
      <AlertDescription>
        Saturday from 02:00 to 04:00 UTC. Expect brief interruptions.
      </AlertDescription>
    </Alert>
  ),
};

export const FormErrorSummary: Story = {
  name: "Composition: form error summary",
  render: (args) => (
    <Alert {...args} role="alert" variant="danger">
      <AlertTitle>Fix 2 fields to continue</AlertTitle>
      <AlertDescription>
        <ul style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>
          <li>
            <a href="#email">Enter a valid email address.</a>
          </li>
          <li>
            <a href="#password">Use at least 8 characters for the password.</a>
          </li>
        </ul>
      </AlertDescription>
    </Alert>
  ),
};

export const StorageWarning: Story = {
  name: "Composition: settings panel",
  render: (args) => (
    <div
      style={{
        background: "var(--color-surface)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-raised)",
        display: "grid",
        gap: 12,
        padding: 16,
      }}
    >
      <div style={{ fontSize: "var(--font-size-title)", fontWeight: 600 }}>
        Storage
      </div>
      <Alert {...args} variant="warning">
        <AlertTitle>You've used 9.1 GB of 10 GB</AlertTitle>
        <AlertDescription>
          Uploads stop when you reach the limit.
        </AlertDescription>
        <AlertActions>
          <Button onClick={fn()} size="sm">
            Upgrade
          </Button>
        </AlertActions>
      </Alert>
      <Alert {...args}>
        <AlertDescription>
          Files in the trash count toward your storage until it's emptied.
        </AlertDescription>
      </Alert>
    </div>
  ),
};
