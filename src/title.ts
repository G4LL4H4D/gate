/**
 * Parse a session title that may contain a routed-model tag.
 *
 * Title format (set by the server): "<description> [routed to <providerID/modelID>]"
 * Returns label + optional model string for display.
 */
export function splitRoutedTitle(title: string): { label: string; model: string | undefined } {
  const m = title.match(/^(.*?)\s*\[routed to ([^\]]+)\]\s*$/)
  if (m) {
    return { label: m[1].trim(), model: m[2].trim() }
  }
  return { label: title, model: undefined }
}

/**
 * Strip the provider prefix from a model string for display.
 * e.g. "opencode/nemotron-3.5-super-vl-free" → "nemotron-3.5-super-vl-free"
 */
export function shortModel(model: string): string {
  const slash = model.indexOf("/")
  return slash >= 0 && slash < model.length - 1 ? model.slice(slash + 1) : model
}
