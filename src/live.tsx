import type { JSX } from "@opentui/solid"
import { Show } from "solid-js"

/**
 * Live caption shown above the composer while real-time transcription is
 * running. Renders nothing when there is no text.
 */
export function LiveTranscript(props: { text: string; color?: string }): JSX.Element {
  return (
    <Show when={props.text.trim()}>
      <box paddingLeft={2} paddingRight={2}>
        <text fg={props.color ?? "#9aa0a6"}>🎙 {props.text}</text>
      </box>
    </Show>
  )
}
