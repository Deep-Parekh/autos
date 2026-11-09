package example.tasks;

public final class Task {
    private final String id;
    private String status = "OPEN";

    public Task(String id) { this.id = id; }
    public String getId() { return id; }
    public String getStatus() { return status; }
    void setStatus(String status) { this.status = status; }
}
