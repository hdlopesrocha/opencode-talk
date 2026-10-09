declare module "@xmpp/client" {
  export function client(options?: Record<string, unknown>): any;
  export function xml(name: string, attrs?: Record<string, unknown>, ...children: unknown[]): any;
}
