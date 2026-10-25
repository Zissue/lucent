import type { Meta, StoryObj } from "storybook-solidjs-vite";

import type { PacketCapturedPayload } from "../../../shared/packets";
import { PacketsView } from "./App";

const capturedAt = Date.UTC(2026, 7, 11, 19, 42, 30);
const packets: readonly PacketCapturedPayload[] = [
  {
    capturedAt,
    packet: "%xt%zm%moveToCell%1%Enter%Spawn%",
    type: "client",
  },
  {
    capturedAt: capturedAt + 180,
    packet: "%xt%zm%getMapItem%1%42%",
    type: "client",
  },
  {
    capturedAt: capturedAt + 320,
    packet:
      '{"t":"xt","b":{"r":-1,"o":{"cmd":"uotls","unm":"PrimaryHero","strFrame":"Walk"}}}',
    type: "server",
  },
  {
    capturedAt: capturedAt + 480,
    packet: '{"event":"script:status","status":"running","name":"Darkon farm"}',
    type: "extension",
  },
  {
    capturedAt: capturedAt + 650,
    packet:
      '{"t":"xt","b":{"r":-1,"o":{"cmd":"ct","m":"A deliberately long packet body that demonstrates wrapped packet rows and horizontal pressure in the real packets window."}}}',
    type: "server",
  },
];

const meta = {
  args: {
    fixture: {
      captureRunning: true,
      filters: { server: true },
      packets,
      showTimestamps: true,
    },
    onCopyText: () => Promise.resolve(),
  },
  component: PacketsView,
  globals: {
    viewport: { isRotated: false, value: "packets" },
  },
  title: "Renderers/Packets",
} satisfies Meta<typeof PacketsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Capturing: Story = {};

export const CaptureStoppedEmpty: Story = {
  args: { fixture: {} },
};

export const WaitingForPackets: Story = {
  args: { fixture: { captureRunning: true } },
};

export const SearchAndSourceFilters: Story = {
  args: {
    fixture: {
      captureRunning: true,
      filters: { client: false, extension: true, server: true },
      packets,
      search: "does-not-exist",
    },
  },
};

export const WrappedPackets: Story = {
  args: {
    fixture: {
      captureRunning: true,
      filters: { server: true },
      packets,
      showTimestamps: true,
      wrapPackets: true,
    },
  },
};

export const SenderQueue: Story = {
  args: {
    fixture: {
      activeTab: "send",
      delayMs: "750",
      queue: [
        "%xt%zm%moveToCell%1%Enter%Spawn%",
        "%xt%zm%getMapItem%1%42%",
        "%xt%zm%cmd%1%tfer%{PLAYER_NAME}%{MAP_NAME}-{ROOM_NUMBER}%",
      ],
      selectedQueueIndex: 1,
      sendTarget: "server-string",
      sendText: "%xt%zm%cmd%1%goto%{PLAYER_NAME}%",
    },
  },
};

export const QueueRunningWithNotice: Story = {
  args: {
    fixture: {
      activeTab: "send",
      notice: "Packet 2 of 4 is waiting for the configured delay.",
      queue: ["first packet", "second packet", "third packet", "fourth packet"],
      queueRunning: true,
      sendTarget: "client-json",
    },
  },
};

export const RuntimeError: Story = {
  args: {
    fixture: {
      activeTab: "send",
      error: "The connection was unavailable.",
      queue: ["%xt%zm%getMapItem%1%42%"],
      sendText: "%xt%zm%moveToCell%1%Enter%Spawn%",
    },
  },
};
