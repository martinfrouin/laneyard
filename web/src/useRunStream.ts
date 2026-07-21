import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/**
 * Suit la sortie d'un run.
 *
 * Le décalage en octets est la clé de la reprise : à la connexion comme après une
 * coupure, on redemande le log depuis le dernier décalage connu, puis on repart
 * du flux. Rien n'est perdu, rien n'est dupliqué.
 */
export function useRunStream(runId: number): { log: string; finished: string | null } {
  const [log, setLog] = useState("");
  const [finished, setFinished] = useState<string | null>(null);
  const offset = useRef(0);
  /**
   * `finished` est aussi tenu dans une référence : `onclose` est installé une
   * seule fois et capturerait sinon la valeur initiale, toujours nulle. La
   * fermeture normale de fin de run relancerait alors une reconnexion, puis une
   * autre, indéfiniment.
   */
  const finishedRef = useRef<string | null>(null);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    // Changer de run repart de zéro : le décalage du précédent ne veut plus rien dire.
    offset.current = 0;
    finishedRef.current = null;
    setLog("");
    setFinished(null);

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
          // Un fragment déjà couvert par le rattrapage est ignoré.
          if (msg.offset < offset.current) return;
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
