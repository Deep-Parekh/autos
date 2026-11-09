package example.tasks;

public final class CompleteTaskRegression {
    public static void main(String[] args) {
        CompleteTaskAction action = new CompleteTaskAction(new TaskService());
        Task task = new Task("AUTO-17");
        if (!"success".equals(action.execute(task))) throw new AssertionError("Action did not return success");
        if (!"RESOLVED".equals(action.getTask().getStatus())) {
            throw new AssertionError("Expected completed task status RESOLVED, got " + action.getTask().getStatus());
        }
    }
}
