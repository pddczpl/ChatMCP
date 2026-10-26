// The checks of one test file of this project, counted and printed the way the checks of Program.cs are. A file that holds the tests of one piece of the shared code
// takes a TestKit and calls Check and Throws; Program.cs adds the count to its own.
internal sealed class TestKit
{
    public int Count { get; private set; }
    /// <summary>A folder of this run that every test may fill and nobody else reads; Program.cs removes it at the end.</summary>
    public string Scratch { get; }

    public TestKit(string scratch) { Scratch = scratch; }

    public void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
        Count++;
        Console.WriteLine("PASS " + message);
    }

    public void Throws(Action action, string message)
    {
        var thrown = false;
        try { action(); } catch (Exception) { thrown = true; }
        Check(thrown, message);
    }

    /// <summary>A new empty folder under <see cref="Scratch"/>.</summary>
    public string Folder(string name)
    {
        var path = Path.Combine(Scratch, name + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(path);
        return path;
    }
}
