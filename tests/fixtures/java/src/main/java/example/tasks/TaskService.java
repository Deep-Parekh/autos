package example.tasks;

public final class TaskService {
    public Task complete(Task task) {
        // Seeded defect: the action reports success but the persisted domain status stays OPEN.
        return task;
    }
}
