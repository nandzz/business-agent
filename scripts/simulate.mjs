#!/usr/bin/env node
// Post a signed, Meta-shaped webhook to the local worker.
//   npm run simulate -- "Ciao, avete posto sabato?"
//   npm run simulate -- --echo "Ti scrivo io tra poco"     (owner typed on the phone)
//   npm run simulate -- --from 393331234567 --name Giulia "Quanto costa un taglio?"
// Reads META_APP_SECRET from .dev.vars. Pair with DRY_RUN=1 unless --from is an
// allowlisted test recipient on your Meta test number.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const [, value] = args.splice(i, 2);
  return value;
};
const echo = args.includes("--echo") && args.splice(args.indexOf("--echo"), 1);
const url = opt("url", "http://localhost:8787/webhook");
const from = opt("from", "393330000000");
const name = opt("name", "Test Customer");
const phoneNumberId = opt("phone-number-id", "TEST_PHONE_NUMBER_ID");
const text = args.join(" ") || "Ciao! Avete posto per un taglio sabato mattina?";

const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
if (!vars.META_APP_SECRET) throw new Error("META_APP_SECRET missing in .dev.vars");

const message = {
  id: `wamid.SIM${randomUUID().replaceAll("-", "")}`,
  timestamp: String(Math.floor(Date.now() / 1000)),
  type: "text",
  text: { body: text },
};
const metadata = { display_phone_number: "15550000000", phone_number_id: phoneNumberId };
const value = echo
  ? { messaging_product: "whatsapp", metadata, message_echoes: [{ ...message, from: metadata.display_phone_number, to: from }] }
  : { messaging_product: "whatsapp", metadata, contacts: [{ wa_id: from, profile: { name } }], messages: [{ ...message, from }] };
const body = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ id: "TEST_WABA_ID", changes: [{ field: echo ? "smb_message_echoes" : "messages", value }] }],
});

const signature = "sha256=" + createHmac("sha256", vars.META_APP_SECRET).update(body).digest("hex");
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-signature-256": signature },
  body,
});
console.log(res.status, await res.text());
