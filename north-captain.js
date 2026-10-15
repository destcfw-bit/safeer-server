function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 90);
}

export function northWhatsappName(sender = {}) {
  const candidates = [
    sender.whatsappName,
    sender.pushName,
    sender.notifyName,
    sender.notify,
    sender.verifiedName,
    sender.displayName,
    sender.name
  ];
  for (const candidate of candidates) {
    const name = cleanName(candidate);
    if (name) return name;
  }
  return "";
}

export function isTrustedNorthWhatsappName(value) {
  const name = cleanName(value);
  return Boolean(
    name &&
    /[^\d\s+@._-]/u.test(name) &&
    !/^كابتن\s*\d+$/u.test(name)
  );
}
