# AUTO-17: completing a task must persist its resolved status

`CompleteTaskAction` returns `success`, but `TaskService.complete` leaves the task status as `OPEN`. Set the task status to `RESOLVED` before returning it. The Java regression in `java/src/test/java/example/tasks/CompleteTaskRegression.java` reproduces the defect. The JSP and browser script display the server-provided status after completion.
