// Verification process only: prevent accidental provider network access.
import net from "node:net";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = typeof first === "object" ? first : { port: first, host: args[1] };
  if (!["127.0.0.1", "::1"].includes(options.host))
    throw new Error("Offline test blocked a connection");
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = (host, ...args) => {
  if (!["127.0.0.1", "::1"].includes(host)) throw new Error("Offline test blocked DNS");
  return lookup(host, ...args);
};
dgram.createSocket = () => {
  throw new Error("Offline test blocked UDP");
};
syncBuiltinESMExports();
