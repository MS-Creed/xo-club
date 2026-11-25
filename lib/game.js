// The eight ways to win on a 3 × 3 board, numbered left-to-right.
export const WINNING_LINES = Object.freeze([
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
]);

export function evaluateBoard(board) {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { status: 'won', winner: board[a], winningLine: [...line] };
    }
  }
  return { status: board.every(Boolean) ? 'draw' : 'playing', winner: null, winningLine: [] };
}

export function otherMark(mark) {
  return mark === 'X' ? 'O' : 'X';
}
