import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/**
 * Follows a run's output.
 *
 * The byte offset is the key to resuming: on connection as after a drop,
 * we request the log again from the last known offset, then pick back up
 * from the stream. Nothing is lost, nothing is duplicated.
 */
export function useRunStream(runId: number): { log: string; finished: string | null } {
  const [log, setLog] = useState("");
  const [finished, setFinished] = useState<string | null>(null);
  const offset = useRef(0);
  /**
   * `finished` is also kept in a ref: `onclose` is installed only once and
   * would otherwise capture the initial value, always null. The normal
   * close at the end of a run would then trigger a reconnection, then
   * another, forever.
   */
  const finishedRef = useRef<string | null>(null);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    // Switching runs starts fresh: the previous run's offset no longer means anything.
    offset.current = 0;
    finishedRef.current = null;
    setLog("");
    setFinished(null);

    /**
     * Reloads the log from the last known offset, until it covers at least
     * `upTo`. The server writes before broadcasting: what the socket
     * announces is therefore already readable through the API.
     */
    const fillGap = async (upTo: number) => {
      const missing = await api.log(runId, offset.current);
      if (closed || !missing) return;
      const gained = new TextEncoder().encode(missing).byteLength;
      if (offset.current + gained < upTo) return; // incomplete catch-up, the next fragment will retry
      offset.current += gained;
      setLog((prev) => prev + missing);
    };

    const connect = async () => {
      if (closed) return;
      const backlog = await api.log(runId, offset.current);
      if (closed) return;
      if (backlog) {
        offset.current += new TextEncoder().encode(backlog).byteLength;
        setLog((prev) => prev + backlog);
      }

      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${location.host}/api/runs/${runId}/stream`);

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as
          | { type: "chunk"; offset: number; data: string }
          | { type: "finished"; status: string };

        if (msg.type === "chunk") {
          // A fragment already covered by the catch-up is ignored.
          if (msg.offset < offset.current) return;

          // A fragment that starts further ahead than where we are signals a
          // gap: output emitted between the catch-up HTTP response and the
          // socket opening reached no one. Appending it as-is would leave a
          // discontinuous log, and would throw off every jump to a step. We
          // catch up on the missing part before continuing.
          if (msg.offset > offset.current) {
            void fillGap(msg.offset);
            return;
          }

          offset.current = msg.offset + new TextEncoder().encode(msg.data).byteLength;
          setLog((prev) => prev + msg.data);
        } else {
          finishedRef.current = msg.status;
          setFinished(msg.status);
        }
      };

      socket.onclose = () => {
        if (!closed && !finishedRef.current) retry = setTimeout(() => void connect(), 1000);
      };
    };

    void connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [runId]);

  return { log, finished };
}
