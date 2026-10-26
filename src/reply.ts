// Last pass over every reply before it goes to WhatsApp. The prompt asks for
// the same style; this makes the few hard rules hold even when the model slips.

/** Plain WhatsApp text: no long dashes, no Markdown beyond *bold*. */
export function cleanReply(text: string): string {
  return (
    text
      // Ranges keep a plain hyphen: 09:00–19:00 → 09:00-19:00.
      .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
      // Any other long dash becomes a comma.
      .replace(/\s*[–—]\s*/g, ", ")
      // Markdown bold/headings → WhatsApp bold / plain lines.
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/^#{1,6}\s+/gm, "")
      // A comma can't open a line or follow another stop.
      .replace(/^,\s*/gm, "")
      .replace(/([.!?:]),\s*/g, "$1 ")
      .trim()
  );
}
