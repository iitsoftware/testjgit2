var shellTopic = parameters.require("shell-topic");
var repoQueue = parameters.optional("repo-queue", "streamrepo@" + stream.routerName());
var cliExecQueue = parameters.optional("repo-queue", "cliexecutor@" + stream.routerName());
var mpQueue = parameters.get("monitorpanel-queue");
var monitorName = stream.name();
var domain = parameters.optional("domain", "dashboard");
var pkg = parameters.optional("package", "flow");
var REPOAPP = domain + "_" + pkg;
var DEPLOYCTX = "/sys$streams/domains/" + domain + "/packages/" + pkg + "/streams";
var WIDTH = 15;
var INTEGER = Java.type("java.lang.Integer");
var STRING = Java.type("java.lang.String");
var sharedQueue = "streams_" + stream.fullyQualifiedName().replace(/\./g, "_") + "_store";

var DEPLOY_PARMS = [
    {
        "name": "name",
        "mandatory": true,
        "description": "Name of the flow",
        "validator": {
            "type": "identifier"
        }
    },
    {
        "name": "timestamp",
        "mandatory": true,
        "description": "Timestamp of the flow",
        "validator": {
            "type": "integer"
        }
    },
    {
        "name": "dependencies",
        "mandatory": false,
        "description": "Dependencies",
        "validator": {
            "type": "string"
        }
    }
];

var UNDEPLOY_PARMS = [
    {
        "name": "name",
        "mandatory": true,
        "description": "Name of the flow",
        "validator": {
            "type": "identifier"
        }
    },
    {
        "name": "preserve",
        "mandatory": false,
        "description": "true: data is preserved, false: data is deleted (default: false)",
        "validator": {
            "type": "choice",
            "values": ["true", "false"]
        }
    }
];

var ACTIVATE_PARMS = [
    {
        "name": "name",
        "mandatory": true,
        "description": "Name of the flow",
        "validator": {
            "type": "identifier"
        }
    },
    {
        "name": "start",
        "mandatory": true,
        "description": "true: starts the flow, false: stops it",
        "validator": {
            "type": "choice",
            "values": ["true", "false"]
        }
    }
];

var LISTFLOW_PARMS = [
    {
        "name": "format",
        "mandatory": false,
        "description": "Return the output in JSON format",
        "validator": {
            "type": "choice",
            "values": ["json"]
        }
    }
];

stream.cli()
    .exceptionOff()
    .execute("cc /sys$streams/domains/" + domain + "/packages")
    .execute("new " + pkg)
    .execute("save");

stream.cli()
    .exceptionOff()
    .execute("cc /sys$queuemanager/queues")
    .execute("new " + sharedQueue)
    .execute("save");


stream.create().input(shellTopic).topic().selector("forward = true and command in ('deploy', 'undeploy', 'listflow', 'activate')").onInput(function (input) {
    var out = stream.create().output(null).forAddress(input.current().replyTo());
    executeCommand(out, input.current().correlationId(), input.current().replyTo(), input.current().property("command").value().toString(), JSON.parse(input.current().property("parameters").value().toString()));
    out.close();
});

stream.create().input(stream.create().tempQueue("streamreporeply")).queue()
    .onInput(function (input) {
        stream.log().info("Stream Repo Result: " + input.current().body().get("operation").value() + "=" + input.current().body().get("success").value());
    });

stream.create().memory("deployments").sharedQueue(sharedQueue).createIndex("name");
stream.create().output(shellTopic).topic();
stream.create().output(mpQueue).queue();
stream.create().output(repoQueue).queue();
stream.create().output(cliExecQueue).queue();

function sendCommands(id, replyTo, commands, exoff) {
    stream.output(cliExecQueue).send(
        stream.create().message()
            .textMessage()
            .correlationId(id)
            .replyTo(replyTo)
            .property("exceptionoff").set(exoff)
            .property("sendshellreply").set(true)
            .property("streamdata").set(true)
            .property("streamname").set(shellTopic)
            .body(JSON.stringify(commands))
    );
}

function sendReply(output, id, result) {
    var REPLY = {
        msgtype: "servicereply",
        streamname: shellTopic,
        eventtype: "commandresult",
        body: {
            time: time.currentTime(),
            message: result
        }
    };
    stream.log().info(JSON.stringify(REPLY));
    output.send(
        stream.create().message()
            .textMessage()
            .correlationId(id)
            .property("streamdata").set(true)
            .property("streamname").set(shellTopic)
            .body(JSON.stringify(REPLY))
    );
}

function executeCommand(output, id, replyTo, cmd, parms) {
    stream.log().info("executeCommand: " + cmd + ", parms=" + JSON.stringify(parms));
    var result;
    switch (cmd) {
        case "deploy":
            sendCommands(id, replyTo, deploy(parms), true);
            break;
        case "undeploy":
            sendCommands(id, replyTo, undeploy(parms), true);
            break;
        case "activate":
            sendCommands(id, replyTo, activate(parms), false);
            break;
        case "listflow":
            sendReply(output, id, listFlow(parms));
            break;
        default:
            sendReply(output, id, ["Error:", "Invalid command: " + cmd]);
            break;
    }
}

function deploy(parms) {
    var flowName = parms[0];
    var timestamp = parms[1];
    var dependencies = parms[2] === "-" ? null : JSON.parse(parms[2]);
    var commands = [];
    commands.push("cc " + DEPLOYCTX);
    commands.push("new " + flowName + "_shell script-file repository:/" + domain + "/shell.js");
    commands.push("cc " + DEPLOYCTX + "/" + flowName + "_shell/parameters");
    commands.push("new monitorpanel-queue value streams_" + domain + "_system_monitorpanel_input");
    commands.push("new register-at-shells value stream_" + stream.routerName() + "_" + domain + "_system_flowshell");
    commands.push("new register-at-shells-command value " + flowName);
    commands.push("new register-at-shells-description value \"" + flowName + " Shell\"");
    commands.push("cc " + DEPLOYCTX + "/" + flowName + "_shell/dependencies");
    commands.push("new " + domain + ".system.flowshell");
    commands.push("cc " + DEPLOYCTX + "/" + flowName + "_shell");
    commands.push("set enabled true");
    commands.push("cc " + DEPLOYCTX);
    commands.push("new " + flowName + " script-file repository:/" + REPOAPP + "/" + flowName + ".js");
    commands.push("cc " + DEPLOYCTX + "/" + flowName + "/dependencies");
    commands.push("new " + domain + ".system.metaregistry");
    commands.push("new " + domain + "." + pkg + "." + flowName + "_shell");
    commands.push("cc " + DEPLOYCTX + "/" + flowName + "/parameters");
    commands.push("new shell-topic value stream_" + stream.routerName() + "_" + domain + "_" + pkg + "_" + flowName + "_shell");
    commands.push("new monitorpanel-queue value " + mpQueue);
    if (dependencies !== null) {
        for (var i = 0; i < dependencies.length; i++) {
            commands.push("cc " + DEPLOYCTX + "/" + flowName + "/dependencies");
            commands.push("new " + domain + "." + pkg + "." + dependencies[i]);
        }
    }
    commands.push("save");
    storeOrUpdateDeployment(flowName, timestamp);
    return commands;
}

function undeploy(parms) {
    var flowName = parms[0];
    var preserve = parms[1] === "true";
    deleteDeployment(flowName);
    stream.output(repoQueue).send(
        stream.create().message().textMessage()
            .replyTo(stream.tempQueue("streamreporeply").destination())
            .property("operation").set("remove")
            .property("app").set(REPOAPP)
            .property("file").set(flowName + ".js")
    );
    var commands = [];
    commands.push("cc " + DEPLOYCTX);
    commands.push("delete " + flowName);
    commands.push("delete " + flowName + "_shell");
    commands.push("save");
    if (preserve === false) {
        commands.push("cc sys$queuemanager/queues");
        commands.push("delete " + domain + "_" + pkg + "_" + flowName + "_flowqueue");
        commands.push("delete state_" + domain + "_" + pkg + "_" + flowName);
        commands.push("save");
    }
    return commands;
}

function activate(parms) {
    var flowName = parms[0];
    var activate = parms[1];
    if (getDeploymentTimestamp(flowName) === undefined)
        return ["Result:", "Flow '" + flowName + "' is not deployed!"];
    var commands = [];
    commands.push("cc " + DEPLOYCTX + "/" + flowName);
    commands.push("set enabled " + activate);
    commands.push("cc " + DEPLOYCTX + "/" + flowName + "_shell");
    commands.push("set enabled " + activate);
    commands.push("save");
    return commands;
}

function listFlow(parms) {
    if (parms.length === 1 && parms[0] !== "-") {
        if (parms[0] !== "json")
            return ["Error:", "Only 'json' is valid as 2nd parameter!"];
        return listFlowJson();
    }
    var result = [];
    result[0] = "Result:";
    result[1] = field("Name", WIDTH, ' ') + "| " + field("Timestamp", WIDTH, ' ') + "| " + field("Activated", WIDTH, ' ');
    result[2] = field("", WIDTH * 3 + 6, '-');
    var names = stream.cli().entityNames(DEPLOYCTX);
    for (var i = 0; i < names.length; i++) {
        if (!names[i].endsWith("_shell"))
            result.push(field(names[i], WIDTH, ' ') + "| " + field(getDeploymentTimestamp(names[i])) + "| " + field(stream.cli().propertyValue(DEPLOYCTX + "/" + names[i], "enabled")));
    }
    return result;

}

function listFlowJson() {
    var result = [];
    var names = stream.cli().entityNames(DEPLOYCTX);
    for (var i = 0; i < names.length; i++) {
        if (!names[i].endsWith("_shell"))
            result.push({
                name: names[i],
                timestamp: getDeploymentTimestamp(names[i]),
                activated: stream.cli().propertyValue(DEPLOYCTX + "/" + names[i], "enabled") === "true"
            });
    }
    return ["Result:", JSON.stringify(result)];

}

function storeOrUpdateDeployment(name, timestamp) {
    var mem = stream.memory("deployments").index("name").get(name);
    if (mem.size() > 0)
        deleteDeployment(name);
    stream.memory("deployments").add(
        stream.create().message().message().property("name").set(name).property("timestamp").set(timestamp)
    );
}

function getDeploymentTimestamp(name) {
    var mem = stream.memory("deployments").index("name").get(name);
    if (mem.size() === 0)
        return undefined;
    var msg = mem.first();
    if (msg.property("timestamp").exists())
        return msg.property("timestamp").value().toObject();
    return undefined;
}

function deleteDeployment(name) {
    stream.memory("deployments").index("name").remove(name);
}

// Startup -> Monitor Panel
stream.onStart(function () {
    sendState("GREEN", monitorName + " active");
    stream.output(shellTopic).send(
        stream.create().message().message()
            .property("registryrequest").set(true)
            .property("operation").set("add")
            .property("command").set("deploy")
            .property("description").set("Deploys a flow")
            .property("parameters").set(JSON.stringify(DEPLOY_PARMS))
    );
    stream.output(shellTopic).send(
        stream.create().message().message()
            .property("registryrequest").set(true)
            .property("operation").set("add")
            .property("command").set("activate")
            .property("description").set("Activates/deactivates a flow")
            .property("parameters").set(JSON.stringify(ACTIVATE_PARMS))
    );
    stream.output(shellTopic).send(
        stream.create().message().message()
            .property("registryrequest").set(true)
            .property("operation").set("add")
            .property("command").set("undeploy")
            .property("description").set("Undeploys a flow")
            .property("parameters").set(JSON.stringify(UNDEPLOY_PARMS))
    );
    stream.output(shellTopic).send(
        stream.create().message().message()
            .property("registryrequest").set(true)
            .property("operation").set("add")
            .property("command").set("listflow")
            .property("description").set("List all flows")
            .property("parameters").set(JSON.stringify(LISTFLOW_PARMS))
    );
});

// Stopped -> Monitor Panel
stream.onStop(function () {
    sendState("YELLOW", monitorName + " inactive");
    stream.output(shellTopic).send(
        stream.create().message().message()
            .property("registryrequest").set(true)
            .property("operation").set("remove")
            .property("command").set("deploy")
    );
    stream.output(shellTopic).send(
        stream.create().message().message()
            .property("registryrequest").set(true)
            .property("operation").set("remove")
            .property("command").set("undeploy")
    );
    stream.output(shellTopic).send(
        stream.create().message().message()
            .property("registryrequest").set(true)
            .property("operation").set("remove")
            .property("command").set("activate")
    );
    stream.output(shellTopic).send(
        stream.create().message().message()
            .property("registryrequest").set(true)
            .property("operation").set("remove")
            .property("command").set("listflow")
    );
});

function field(s, length, c) {
    var res = s;
    for (var i = s.length; i < length; i++)
        res += c;
    return res;
}

function sendState(state, message) {
    stream.output(mpQueue).send(stream.create().message().textMessage().property("name").set(monitorName).body(createJson(state, message)));
    stream.log().info(state + ": " + message);
}

function createJson(state, message) {
    return JSON.stringify({
        name: monitorName,
        state: state,
        time: time.currentTime(),
        message: message
    });
}
