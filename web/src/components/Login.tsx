import { useState } from "react";
import { api } from "../api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [failed, setFailed] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await api.login(password)) onSuccess();
    else setFailed(true);
  };

  return (
    <div className="login">
      <form className="panel" onSubmit={(e) => void submit(e)}>
        <p className="brand">laneyard</p>
        <label>
          password{" "}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        <button type="submit">enter</button>
        {failed && <p className="status-failed">incorrect password</p>}
      </form>
    </div>
  );
}
