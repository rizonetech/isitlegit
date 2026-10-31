// The words that mark hidden text as speaking to a reader other than the member (D02 T05 §1), apart from the HTML
// scanner so the phrase matcher can rank invisible text by them without the HTML rewriter (D02 T05 §3).
export const INSTRUCTION =
  /\b(ignore|disregard|instruction|instructions|assistant|system|prompt|classify|classified|safe|legitimate|verdict|override|model|ai)\b/i;
export const hasInstruction = (text: string) => INSTRUCTION.test(text);
