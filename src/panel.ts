/**
 * Split session IDs into running (always shown) and finished (capped).
 * Returns the IDs to render and the count of hidden finished rows.
 */
export function limitRows(
  ids: string[],
  isRunning: (id: string) => boolean,
  maxFinished = 8,
): { rows: string[]; hidden: number } {
  const running: string[] = []
  const finished: string[] = []
  for (const id of ids) {
    if (isRunning(id)) running.push(id)
    else finished.push(id)
  }
  const hidden = finished.length > maxFinished ? finished.length - maxFinished : 0
  return { rows: [...running, ...finished.slice(0, maxFinished)], hidden }
}
