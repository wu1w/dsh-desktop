// React wraps native keyboard events, while DOM listeners receive them directly.
// Key code 229 also covers IME events whose isComposing flag is already false.
export function isComposing(event){
  return Boolean(event?.isComposing||event?.nativeEvent?.isComposing||event?.keyCode===229||event?.nativeEvent?.keyCode===229||event?.which===229||event?.nativeEvent?.which===229);
}
