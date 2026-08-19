export function updateProjectSession(projects, projectId, sessionId, patch) {
  return projects.map((project) => project.id !== projectId
    ? project
    : {
        ...project,
        sessions: project.sessions.map((session) => session.id === sessionId
          ? { ...session, ...patch }
          : session),
      });
}

export function updateSessionById(projects, sessionId, patch) {
  return projects.map((project) => ({
    ...project,
    sessions: project.sessions.map((session) => session.id === sessionId
      ? { ...session, ...patch }
      : session),
  }));
}

export function composerActionState(session, draft) {
  const running = session?.running === true;
  const submitting = session?.submitting === true;
  const cancelling = session?.cancelling === true;
  const stoppingAvailable = running || submitting;
  const pending = stoppingAvailable || cancelling;
  return {
    mode: cancelling ? "cancelling" : running ? "running" : submitting ? "submitting" : "idle",
    running,
    submitting,
    cancelling,
    pending,
    label: cancelling ? "正在停止" : stoppingAvailable ? "停止生成" : "发送消息",
    disabled: session === undefined || session === null || cancelling || (!stoppingAvailable && draft.trim() === ""),
  };
}
