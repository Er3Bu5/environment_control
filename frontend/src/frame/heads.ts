/* When a zone card's combine note doesn't fit beside its name it wraps under it, and that card's tracks would start lower
   than its neighbour's. So every head in a visual row takes the tallest one's height, as the design mock's levelHeads does.

   Given each head's natural box (its min-height cleared), the min-height each needs, or null where it is already the
   tallest in its row. Heads share a row when their tops round to the same pixel. */
export function levelledHeights(boxes: { top: number; height: number }[]): (number | null)[] {
  const tallest = new Map<number, number>();
  for (const b of boxes) tallest.set(Math.round(b.top), Math.max(tallest.get(Math.round(b.top)) ?? 0, b.height));
  return boxes.map((b) => {
    const t = tallest.get(Math.round(b.top)) ?? 0;
    return t > b.height + 0.5 ? t : null;
  });
}
