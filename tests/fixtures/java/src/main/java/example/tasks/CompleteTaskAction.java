package example.tasks;

/** Small Struts-style action used by the synthetic issue fixture. */
public final class CompleteTaskAction {
    private final TaskService service;
    private Task task;

    public CompleteTaskAction(TaskService service) { this.service = service; }
    public String execute(Task task) {
        this.task = service.complete(task);
        return "success";
    }
    public Task getTask() { return task; }
}
