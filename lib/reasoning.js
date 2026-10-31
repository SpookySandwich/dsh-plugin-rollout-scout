// DSH rc.5 prepares this leading metadata envelope for display in ui-chat.
// Scout consumes raw agent frames, so apply the same boundary before scoring.
// Only a leading signature is metadata; other markup and later tags are prose.
export function reasoningText(text) {
  if (text[0] !== '<') return text;
  const opening = '<signature>';
  if (opening.startsWith(text)) return '';
  if (!text.startsWith(opening)) return text;
  const closing = '</signature>';
  const end = text.indexOf(closing, opening.length);
  if (end === -1) return '';
  let start = end + closing.length;
  while (start < text.length) {
    if (text[start] === '\n') start += 1;
    else if (text[start] === '\r' && text[start + 1] === '\n') start += 2;
    // A CRLF separator can cross chunks. Do not publish the CR and later
    // retract it: consumers accumulate only newly available prose.
    else if (text[start] === '\r' && start === text.length - 1) return '';
    else break;
  }
  return text.slice(start);
}
