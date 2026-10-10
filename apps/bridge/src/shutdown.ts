export async function stopServices(stoppers: Array<() => void | Promise<void>>): Promise<unknown[]> {
  const results = await Promise.allSettled(stoppers.map(async (stop) => stop()));
  return results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
}
