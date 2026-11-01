// Transcripts need a paid provider plan, so they are off in the MVP (fix 5: TRANSCRIPTS_ENABLED=false).
// The interface stays so enabling them later is an implementation, not a redesign.

export interface TranscriptTurn {
  speaker: string;
  role: string | null;
  text: string;
}

export interface Transcript {
  ticker: string;
  fiscalPeriod: string;
  provider: string;
  providerId: string;
  turns: TranscriptTurn[];
}

export interface TranscriptSource {
  readonly enabled: boolean;
  /** Null when the provider has no transcript for the period (the event proceeds without it). */
  getTranscript(ticker: string, fiscalPeriod: string): Promise<Transcript | null>;
}

export class DisabledTranscriptSource implements TranscriptSource {
  readonly enabled = false;
  async getTranscript(): Promise<null> {
    return null;
  }
}
