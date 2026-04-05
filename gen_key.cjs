const crypto = require("crypto");
const { gcmsiv } = require("@noble/ciphers/aes.js");
const name = "adpilot-prod";
const secret = Buffer.from(process.env.CONVEX_INSTANCE_SECRET || "", "hex");
if (secret.length === 0) { console.error("Need CONVEX_INSTANCE_SECRET"); process.exit(1); }
const counter = Buffer.alloc(4); counter.writeUInt32BE(1, 0);
const aesKey = crypto.createHmac("sha256", secret).update(Buffer.concat([counter, Buffer.from("admin key")])).digest().subarray(0, 16);
const now = Math.floor(Date.now() / 1000);
const bn = BigInt(now); const vb = []; let v = bn;
while (v > 0x7fn) { vb.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; } vb.push(Number(v & 0x7fn));
const payload = Buffer.concat([Buffer.from([0x10]), Buffer.from(vb), Buffer.from([0x18, 0x00])]);
const nonce = crypto.randomBytes(12);
const ver = Buffer.from([0x01]);
const ct = gcmsiv(aesKey, nonce, ver).encrypt(payload);
console.log(name + "|" + Buffer.concat([ver, nonce, Buffer.from(ct)]).toString("hex"));
