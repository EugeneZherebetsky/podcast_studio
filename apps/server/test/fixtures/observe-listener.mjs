import net from "node:net";
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once("listening", () => process.send?.({ type: "observed-listener", address: this.address() }));
  return listen.apply(this, args);
};
