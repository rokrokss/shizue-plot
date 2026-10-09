/**
 * The composer's `*` button, as a function of the field it acts on.
 *
 * Stage directions are written `*like this*` and the model is told to answer in
 * the same notation, so the button is a toggle rather than an insert: pressing it
 * on text already wrapped takes the stars off again, and pressing it twice on an
 * empty caret leaves the field as it was found. Everything about where the caret
 * ends up is decided here, so the composer only has to hand the result back to
 * the textarea.
 */

const STAR = '*';

export interface DirectionMarkup {
  value: string;
  selStart: number;
  selEnd: number;
}

export function toggleDirectionMarkup(
  value: string,
  selStart: number,
  selEnd: number,
): DirectionMarkup {
  if (selStart === selEnd) {
    // An empty pair around the caret is one the button just put there; the second
    // press takes it back.
    if (value.slice(selStart - 1, selStart + 1) === `${STAR}${STAR}`) {
      return {
        value: value.slice(0, selStart - 1) + value.slice(selStart + 1),
        selStart: selStart - 1,
        selEnd: selStart - 1,
      };
    }
    return {
      value: `${value.slice(0, selStart)}${STAR}${STAR}${value.slice(selStart)}`,
      selStart: selStart + 1,
      selEnd: selStart + 1,
    };
  }

  const selected = value.slice(selStart, selEnd);

  // Stars inside the selection: the reader selected the direction with its marks.
  if (selected.length >= 2 && selected.startsWith(STAR) && selected.endsWith(STAR)) {
    return {
      value: value.slice(0, selStart) + selected.slice(1, -1) + value.slice(selEnd),
      selStart,
      selEnd: selEnd - 2,
    };
  }

  // Stars just outside it: the reader selected the text the marks are around.
  if (value[selStart - 1] === STAR && value[selEnd] === STAR) {
    return {
      value: value.slice(0, selStart - 1) + selected + value.slice(selEnd + 1),
      selStart: selStart - 1,
      selEnd: selEnd - 1,
    };
  }

  return {
    value: `${value.slice(0, selStart)}${STAR}${selected}${STAR}${value.slice(selEnd)}`,
    selStart: selStart + 1,
    selEnd: selEnd + 1,
  };
}
