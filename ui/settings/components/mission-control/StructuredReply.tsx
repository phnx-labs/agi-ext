import React, { useState } from 'react'
import { Icon } from './icons'
import type { FloorPhase, ReplyKind, StructuredQuestion } from './floorModel'
import { renderMarkdown } from '../../utils/markdown'

// Option-button reply block. Prototype structuredReply(): factory-floor.html:591-597.
// Used inline in feed items and in the right-pane decision block (rendered by SHELL).
// Structured replies, never a bare free-text box: option chips for choices,
// Confirm/Cancel (destructive styled red), Retry for failed, plus a free-text escape
// hatch and a Screenshot attach.

/** Reply callbacks raised by any structured-reply surface (feed item, cluster, detail). */
export interface ReplyCallbacks {
  /** An option chip (or Retry / View error) was clicked; carries the button label. */
  onOption: (option: string) => void
  /** The free-text escape hatch was submitted. */
  onFreeText: (text: string) => void
  /** The Screenshot attach button was clicked. */
  onAttach: () => void
}

interface StructuredReplyProps extends ReplyCallbacks {
  question: StructuredQuestion | null
  phase: FloorPhase
  /**
   * How a reply reaches this agent (`FloorAgent.reply.kind`). When `'none'` there is no
   * injectable channel, so the input controls are replaced up front with the reason —
   * never a chip/Send that only reveals its unreachability after a click (PHNX-2980).
   */
  replyKind: ReplyKind
  /** Human reason a `'none'` channel is unreachable (`FloorAgent.reply.reason`). */
  replyReason?: string
  /** Inline delivery error (no reachable channel, or the CLI send failed). Shown red. */
  error?: string
}

export function StructuredReply({ question, phase, replyKind, replyReason, onOption, onFreeText, onAttach, error }: StructuredReplyProps) {
  const [text, setText] = useState('')
  const danger = question?.kind === 'destructive'
  const options = question?.options ?? []
  const failed = phase === 'failed'

  const send = () => {
    const t = text.trim()
    if (!t) return
    onFreeText(t)
    setText('')
  }

  // The question text itself (from an AskUserQuestion tool call or the parsed last
  // message). Shown right above the options so the choice has its prompt attached —
  // skipped for 'retry', where the failure message is already the card body.
  const questionText = question && question.kind !== 'retry' ? question.text.trim() : ''

  // No injectable channel: state the reason up front instead of rendering chips + a
  // free-text box + Send that only fail after a click (PHNX-2980). The reason is already
  // computed by deriveReplyTargetFromRemote / the local adapter — we surface it, we don't
  // invent a transport. The question text is still shown so you can see what it's asking.
  if (replyKind === 'none') {
    return (
      <>
        {questionText && <div className="qtext md">{renderMarkdown(questionText)}</div>}
        <div className="reply-unreachable" role="note" data-testid="reply-unreachable">
          <Icon name="terminal" size={12} />
          <span>{replyReason ?? 'No reply channel here — open the terminal to answer.'}</span>
        </div>
      </>
    )
  }

  return (
    <>
      {questionText && <div className="qtext md">{renderMarkdown(questionText)}</div>}
      <div className="opts">
        {options.map((o, i) => (
          <button
            key={o}
            className={`opt ${i === 0 ? (danger ? 'danger' : 'primary') : 'ghost'}`}
            onClick={() => onOption(o)}
          >
            {o}
          </button>
        ))}
        {failed && (
          <>
            <button className="opt primary" onClick={() => onOption('Retry')}>Retry</button>
            <button className="opt ghost" onClick={() => onOption('View error')}>View error</button>
          </>
        )}
        {/* Screenshot attach hidden until a transport exists (was a no-op stub). */}
      </div>
      <div className="reply2">
        <input
          placeholder="…or reply in your own words"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send() }}
        />
        <button className="opt ghost" onClick={send}>Send</button>
      </div>
      {error && <div className="reply-err" role="alert">{error}</div>}
    </>
  )
}
