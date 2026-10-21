/**
 * Reads from a vendor that a step's answer needs and the platform does not keep: a call's transcript (the recorder's),
 * the CRM's Sales Call records still blank, the reports only a vendor can answer (calendar availability, the health
 * sweep's probes). They come with the connectors; until then a caller passes them (the simulator from a scenario's
 * fixtures), and without one the answer has nothing from that vendor in it.
 */
export type VendorReads = {
  /** The recorder's words for these recordings, by id. */
  transcripts?: (offerId: string, recordingIds: string[]) => Promise<Record<string, string>>;
  /** The CRM's Sales Call records for a closer's calls with no outcome filed in the CRM, by local day. */
  salesCallsBlank?: (offerId: string, x: { closer: Record<string, unknown>; from: string; to: string }) => Promise<{ day: string; name: string; appointment_id: string | null }[]>;
  /** A report only a vendor can answer (its definition's kind is a vendor's: availability, health_check). */
  vendorReport?: (offerId: string, x: { key: string; kind: string; params: Record<string, unknown>; now: Date }) => Promise<unknown>;
};
