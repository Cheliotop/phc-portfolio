// Reads every row of a query by pages instead of stopping at the server's row cap
// (PostgREST returns at most 1000 rows per request by default; audit WEB-7).
// fetchPage receives an inclusive [from, to] range and returns that page's rows.
export const fetchAllPages = async <T>(
  fetchPage: (from: number, to: number) => Promise<T[] | null>,
  pageSize = 1000,
): Promise<T[]> => {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = (await fetchPage(from, from + pageSize - 1)) ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
};

// Ids passed to .in() travel in the request URL, which has a length limit. A list that
// grows with history (every shift of a well, every shift an operator joined) is sent in
// batches of this many.
export const ID_BATCH = 100;

export const inBatches = <T>(ids: T[], size = ID_BATCH): T[][] => {
  const batches: T[][] = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
};
