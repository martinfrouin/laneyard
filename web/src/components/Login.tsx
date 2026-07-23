import { useState } from "react";
import { api } from "../api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [failed, setFailed] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await api.login(name.trim(), password)) onSuccess();
    else setFailed(true);
  };

  return (
    <div className="login">
      <form className="panel" onSubmit={(e) => void submit(e)}>
        <p className="brand">laneyard</p>
        <label>
          name <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus
            spellCheck={false} autoComplete="username" />
        </label>
        <label>
          password{" "}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" />
        </label>
        <button type="submit">enter</button>
        {/* One message for a wrong password and for a name that does not exist,
            because the server answers the same for both — telling them apart
            here would undo what it takes care not to say. */}
        {failed && <p className="status-failed">incorrect name or password</p>}
      </form>
    </div>
  );
}
