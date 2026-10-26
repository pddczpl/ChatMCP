using System.Text.Json;
using ChatMCP.Native;

// Whether the Hub is doing work that an update would cut off, and the code an installation step that refuses carries. The rule (HubLifecycle.WorkInState and WorkInCoding, which
// StopInstalledHub applies before it stops the Hub and the shell applies before it exits) is held to ONE list of cases with the page's port of it (CHATMCP-HUB/ui/tests/updates.test.mjs).
internal static class WorkTests
{
    internal static void Run(TestKit kit)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "active-work-cases.json");
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        var cases = document.RootElement.GetProperty("cases").EnumerateArray().ToList();
        kit.Check(cases.Count == 36, "the list holds " + cases.Count + " cases (36: the docs say so; a case added to the list is added there too)");
        foreach (var item in cases)
        {
            var name = item.GetProperty("name").GetString()!;
            var state = item.GetProperty("state");
            var coding = item.GetProperty("coding");
            kit.Check((HubLifecycle.WorkInState(state) != null) == item.GetProperty("inState").GetBoolean(), "work in the state: " + name + " is " + item.GetProperty("inState").GetBoolean());
            if (coding.ValueKind != JsonValueKind.Null)
                kit.Check((HubLifecycle.WorkInCoding(coding) != null) == item.GetProperty("inCoding").GetBoolean(), "work in the coding answer: " + name + " is " + item.GetProperty("inCoding").GetBoolean());
        }

        // The words are the ones the installer has always said (a lifecycle script and a person may read them), and each carries the code the result file and the page use.
        using var tasks = JsonDocument.Parse("{\"agent\":{\"activeTaskId\":\"t\"}}");
        using var studio = JsonDocument.Parse("{\"agent\":{},\"studio\":{\"terminals\":[{\"running\":true}]}}");
        using var codingRun = JsonDocument.Parse("{\"activeRunId\":\"r\"}");
        using var idle = JsonDocument.Parse("{\"agent\":{}}");
        kit.Check(HubLifecycle.WorkInState(tasks.RootElement) == "Stop active DatGold tasks before installing or uninstalling. Nothing was cancelled.", "running tasks: the installer's words");
        kit.Check(HubLifecycle.WorkInState(studio.RootElement) == "Stop DatGold terminals and background workers before upgrading.", "a running terminal or worker: its words");
        kit.Check(HubLifecycle.WorkInCoding(codingRun.RootElement) == "Stop background coding jobs before upgrading.", "a running coding job: its words");
        kit.Check(HubLifecycle.WorkInState(idle.RootElement) == null && HubLifecycle.WorkInCoding(idle.RootElement) == null, "an idle Hub: nothing");

        // ---- the code of a step that refuses
        kit.Check(StepCode.Of(new IOException("x").Tag("window_open")) == "window_open", "a step that refuses carries its code in Exception.Data, whatever type of exception it is");
        kit.Check(StepCode.Of(new IOException("outer", new InvalidOperationException("inner").Tag("tasks_running"))) == "tasks_running", "and it is found through the inner exceptions");
        kit.Check(StepCode.Of(new IOException("untagged")) == null && StepCode.Of(null) == null, "an exception with no code has none");
        kit.Check(StepCode.Of(new AggregateException("many", new IOException("one"), new InvalidOperationException("two").Tag("hub_stop_failed"))) == "hub_stop_failed", "an aggregate is searched too");
        kit.Check(StepCode.Of(new IOException("tagged with a thing that is not a code").Tag("")) == null, "an empty code is no code");
        kit.Check(StepCode.IsKnown("tasks_running") && StepCode.IsKnown("install_failed") && !StepCode.IsKnown("a path C:\\Users\\x") && !StepCode.IsKnown(null) && !StepCode.IsKnown("Tasks_Running"), "only a code of the closed list is ever written to a result file");
    }
}
