using System.Text.Json.Serialization;

namespace ChatMCP.Sandbox.GuestSupervisor;

public sealed class NativeSecurityEvidence
{
    [JsonPropertyName("version")] public int Version { get; set; } = 1;
    [JsonPropertyName("diagnosticOnly")] public bool DiagnosticOnly { get; set; }
    [JsonPropertyName("supervisorSid")] public string SupervisorSid { get; set; } = "";
    [JsonPropertyName("supervisorIntegritySid")] public string SupervisorIntegritySid { get; set; } = "";
    [JsonPropertyName("supervisorPid")] public int SupervisorPid { get; set; }
    [JsonPropertyName("childSid")] public string ChildSid { get; set; } = "";
    [JsonPropertyName("childIntegritySid")] public string ChildIntegritySid { get; set; } = "";
    [JsonPropertyName("freshAccount")] public bool FreshAccount { get; set; }
    [JsonPropertyName("childToken")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public NativeChildTokenEvidence? ChildToken { get; set; }
    [JsonPropertyName("sealPath")] public string SealPath { get; set; } = "";
    [JsonPropertyName("sealOwnerSid")] public string SealOwnerSid { get; set; } = "";
    [JsonPropertyName("sealSddl")] public string SealSddl { get; set; } = "";
    [JsonPropertyName("sealIntegritySid")] public string SealIntegritySid { get; set; } = "";
    [JsonPropertyName("sealRecordBytes")] public long SealRecordBytes { get; set; }
    [JsonPropertyName("runtimeDynamicCodeSupported")] public bool RuntimeDynamicCodeSupported { get; set; }
    [JsonPropertyName("loadedModules")] public string[] LoadedModules { get; set; } = [];
}

public sealed class NativeChildTokenEvidence
{
    [JsonPropertyName("ownerSid")] public string OwnerSid { get; set; } = "";
    [JsonPropertyName("groupSid")] public string GroupSid { get; set; } = "";
    [JsonPropertyName("sddl")] public string Sddl { get; set; } = "";
    [JsonPropertyName("adminEnabled")] public bool AdminEnabled { get; set; }
    [JsonPropertyName("groups")] public NativeTokenGroup[] Groups { get; set; } = [];
    [JsonPropertyName("privileges")] public NativeTokenPrivilege[] Privileges { get; set; } = [];
}

public sealed class NativeTokenGroup
{
    [JsonPropertyName("sid")] public string Sid { get; set; } = "";
    [JsonPropertyName("attributes")] public uint Attributes { get; set; }
}

public sealed class NativeTokenPrivilege
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("attributes")] public uint Attributes { get; set; }
}
