// Narration plus a quiet ambient pad. The pad dips only a little while someone speaks, and eases in and
// out over about a second, so there is no sharp cut between speech and silence.
export const mixFilter = (narrationIdx: number, musicIdx: number, total: number) =>
  `[${narrationIdx}:a]loudnorm=I=-16:TP=-1.5:LRA=11,asplit=2[n1][n2];` +
  `[${musicIdx}:a]lowpass=f=2800,volume=0.5,afade=t=in:d=3[m];` +
  `[m][n2]sidechaincompress=threshold=0.04:ratio=2.5:attack=600:release=2500:makeup=1[md];` +
  `[n1][md]amix=inputs=2:normalize=0,afade=t=in:d=0.4,afade=t=out:st=${(total - 3).toFixed(2)}:d=3[a]`;
