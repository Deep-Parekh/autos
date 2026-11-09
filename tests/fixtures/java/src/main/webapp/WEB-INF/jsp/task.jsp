<%@ page contentType="text/html; charset=UTF-8" %>
<%@ taglib prefix="s" uri="/struts-tags" %>
<section id="task" data-id="<s:property value='task.id'/>" data-status="<s:property value='task.status'/>">
  <h1>Task <s:property value="task.id"/></h1>
  <span class="task-status"><s:property value="task.status"/></span>
  <button id="complete-task" type="button">Complete task</button>
</section>
<script src="/assets/task.js" defer></script>
