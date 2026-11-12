// Guards for Cierres' dossier loads. A reply or a post-action reload may only
// touch the screen while its Ficha / project is still the one selected (WEB-5).

export const isDossierReplyCurrent = (
  replyProjectId: number,
  selectedProjectId: number | null | undefined,
): boolean => selectedProjectId !== null && selectedProjectId !== undefined && replyProjectId === selectedProjectId;

export const shouldReloadAfterAction = (
  selectedReportId: number | null | undefined,
  actedReportId: number,
): boolean => selectedReportId === actedReportId;

// The compiled dossier is for the project's latest Ficha; any other Ficha must not sign,
// return or print against it.
export const isDossierMismatch = (
  dossierCompletionId: number | null | undefined,
  reportId: number,
): boolean => Boolean(dossierCompletionId && dossierCompletionId !== reportId);
