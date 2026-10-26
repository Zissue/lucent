/** Native responses are never Node incoming messages, so `instanceof` checks fall through. */
export class NodeHttpIncomingMessage {
  readonly source = { headers: {}, statusMessage: "" };
  readonly status = 0;
}
