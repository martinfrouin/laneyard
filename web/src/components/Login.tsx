import { useState } from "react";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [failed, setFailed] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { api } = await import("../api");
    if (await api.login(password)) onSuccess();
    else setFailed(true);
  };

  return (
    <div className="login">
      <form className="panel" onSubmit={(e) => void submit(e)}>
        <p className="brand">laneyard</p>
        <label>
          mot de passe{" "}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        <button type="submit">entrer</button>
        {failed && <p className="status-failed">Mot de passe incorrect</p>}
      </form>
    </div>
  );
}
