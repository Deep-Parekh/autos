document.addEventListener('DOMContentLoaded', () => {
  const button = document.querySelector('#complete-task');
  const task = document.querySelector('#task');
  if (!button || !task) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const response = await fetch(`/tasks/${encodeURIComponent(task.dataset.id)}/complete`, { method: 'POST' });
      if (!response.ok) throw new Error('request failed');
      const updated = await response.json();
      task.dataset.status = updated.status;
      task.querySelector('.task-status').textContent = updated.status;
    } finally {
      button.disabled = false;
    }
  });
});
