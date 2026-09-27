export const participantColors = ["#5b765f", "#94705d", "#647b9a", "#8b7296", "#a17d49", "#4e8885"];

export function participantColor(index: number) {
  return participantColors[index % participantColors.length];
}

export function seededParticipantColor(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  return participantColors[hash % participantColors.length];
}
