var streamname = ("stream_" + stream.routerName() + "_" + stream.fullyQualifiedName()).replace(/\./g, "_").replace(/\./g, "_");
var registryTopic = parameters.optional("registry-topic", "stream_" + stream.routerName() + "_streamregistry");
var registerAtShells = parameters.get("register-at-shells");
var registerAtShellsCommand = parameters.get("register-at-shells-command");
var registerAtShellsDescription = parameters.get("register-at-shells-description");
var hasProps = parameters.optional("has-properties", "false");
var mpQueue = parameters.get("monitorpanel-queue");
var monitorName = stream.name();
var WIDTH_L = 20;
var WIDTH_R = 50;
var INTEGER = /^\d+$/;
var IDENTIFIER = /^([a-zA-Z_][a-zA-Z\d_]*)$/;
var DESTINATION = /^([a-zA-Z_.%$][a-zA-Z\d_.%$]*)$/;
var sharedQueue = "streams_"+ stream.fullyQualifiedName().replace(/\./g, "_") + "_store";

var HOWTO = ['Result:',
    'HOW TO EXECUTE COMMANDS',
    '\n',
    'Commands may have parameters which are delimited by a blank:',
    '\n',
    '  cmd parm1 parm2 parm3',
    '\n',
    'If a parameter contains blanks, double quote it:',
    '\n',
    '  cmd "parm with blank"',
    '\n',
    'If a parameter contains double quotes, use 2 double quotes for each double quote:',
    '\n',
    '  cmd "parm ""with"" blank"',
    '\n',
    'Optional parameters are shown as [<parm>]. If the optional parameter should not be set,',
    'specify a "-" instead:',
    '\n',
    '  cmd - parm2 parm3',
    '\n',
    'Parameters shown as <param> are mandatory.'
];

var shellCommands = [
    "Result:",
    field("Command", WIDTH_L, ' ') + "| " + field("Description", WIDTH_R, ' '),
    field("", WIDTH_L + WIDTH_R + 2, '-'),
    field("howto", WIDTH_L, ' ') + "| " + field("How to execute commands", WIDTH_R, ' '),
    field("help", WIDTH_L, ' ') + "| " + field("Show available commands", WIDTH_R, ' ')
];

if (hasProps === "true"){
    shellCommands.push(
        field("set", WIDTH_L, ' ') + "| " + field("Sets a property", WIDTH_R, ' '),
        field("  <name>", WIDTH_L, ' ') + "| " + field("  Property name", WIDTH_R, ' '),
        field("  [<value>]", WIDTH_L, ' ') + "| " + field("  Property value. Property is deleted if ommitted.", WIDTH_R, ' '),
        field("get", WIDTH_L, ' ') + "| " + field("Return the value of a property", WIDTH_R, ' '),
        field("  <name>", WIDTH_L, ' ') + "| " + field("  Property name", WIDTH_R, ' '),
        field("list [json]", WIDTH_L, ' ') + "| " + field("List properties, optionally in JSON format", WIDTH_R, ' '),
        field("clear", WIDTH_L, ' ') + "| " + field("Clears all properties", WIDTH_R, ' ')
    );
    stream.cli().execute("cc /sys$queuemanager/queues")
        .exceptionOff()
        .execute("new " + sharedQueue)
        .execute("save");
    stream.create().memory("properties").sharedQueue(sharedQueue).createIndex("name");
    HOWTO.push(
        '\n',
        'If a command is executed which has parameters but only the command without parameters is',
        'specified, the corresponding properties needs to be set. The names of the properties are',
        'the names of the parameter of the command (see help):',
        '\n',
        '  cmd <myparm>',
        '\n',
        'can be executed by',
        '\n',
        '  cmd abcd',
        '\n',
        'or by',
        '\n',
        '  set myparm abcd',
        '  cmd',
        '\n',
        'To mix parameters and properties in a command, use "$" for the resp. parameter position:',
        '\n',
        '  cmd <myparm1> <myparm2>',
        '\n',
        'can be executed by',
        '\n',
        '  set myparm1 abcd',
        '  cmd $ efgh',
        '\n',
        'Properties are persistent and can be set any time. They are also global, visible for all users.',
        '\n'
    );
}

var Util = Java.type("com.swiftmq.util.SwiftUtilities");

var upperShells;

if (registerAtShells) {
    if (!registerAtShellsCommand)
        throw "Parameter 'register-at-shells-command required' if 'register-at-shells' is set";
    if (!registerAtShellsDescription)
        throw "Parameter 'register-at-shells-description' required if 'register-at-shells' is set";
    upperShells = registerAtShells.split(" ");
}

stream.create().memory("commands").heap().createIndex("command");
stream.create().memory("contexts").heap().createIndex("command");

// Init Requests
stream.create().input("initrequests").topic().destinationName(streamname).selector("initrequest = true")
    .onInput(function (input) {
        var out = stream.create().output(null).forAddress(input.current().replyTo());
        sendInit(out, input.current().correlationId());
        out.close();
    });

// Command Requests
stream.create().input("commandrequests").topic().destinationName(streamname).selector("commandrequest = true")
    .onInput(function (input) {
        stream.log().info("Received command: " + input.current().body());
        var out = stream.create().output(null).forAddress(input.current().replyTo());
        executeCommand(out, input.current());
        out.close();
    });

// Shell Registry Requests
stream.create().input("registryrequests").topic().destinationName(streamname).selector("registryrequest = true")
    .onInput(function (input) {
        if (input.current().property("operation").value().toString() === "add")
            registerCommand(input.current());
        else
            unregisterCommand(input.current());
    });
stream.create().output(streamname).topic();

// Upper Shells
if (registerAtShells) {
    upperShells.forEach(function (shell) {
        stream.create().output(shell).topic();
    });
}

if (mpQueue)
    stream.create().output(mpQueue).queue();

function registerCommand(request) {
    var command = request.property("command").value().toString();
    var description = request.property("description").value().toString();
    var isShell = request.property("shell").exists() && request.property("shell").value().toBoolean() === true;
    var parms = request.property("parameters").exists() ? request.property("parameters").value().toString() : "[]";
    var msg = stream.create().message().message()
        .property("command").set(command)
        .property("description").set(description)
        .property("shell").set(isShell)
        .property("parameters").set(parms);
    if (isShell) {
        msg.property("streamname").set(request.property("streamname").value().toString());
        stream.create().output(request.property("streamname").value().toString()).topic();
        stream.memory("contexts").add(msg);
    } else
        stream.memory("commands").add(msg);
}

function unregisterCommand(request) {
    var command = request.property("command").value().toString();
    var isShell = request.property("shell").exists() && request.property("shell").value().toBoolean() === true;
    if (isShell)
        stream.memory("contexts").index("command").remove(command);
    else
        stream.memory("commands").index("command").remove(command);
}

function setProperty(cmd) {
    var command = Util.cutFirst(cmd);
    if (command === null || command.length > 2)
        return ["Error:", "Invalid number of parameters for this command"];
    try {
        var propMem = stream.memory("properties").index("name").get(command[0]);
        if (propMem.size() > 0)
            stream.memory("properties").index("name").remove(command[0]);
        if (command.length === 2) {
            stream.memory("properties").add(stream.create().message().message().property("name").set(command[0]).property("value").set(command[1]));
            return ["Result:", "Property '" + command[0] + "' set to '" + command[1] + "'"];
        } else
            return ["Result:", "Property '" + command[0] + "' deleted."];
    } catch (e) {
        return ["Error:", e.toString()];
    }
}

function getProperty(cmd) {
    var command = Util.cutFirst(cmd);
    if (command === null || command.length !== 1)
        return ["Error:", "Invalid number of parameters for this command"];
    return ["Result:", getProp(command[0])];
}

function getProp(name) {
    var value = "undefined";
    if (hasProps !== "true")
        return value;
    var mem = stream.memory("properties").index("name").get(name);
    if (mem.size() > 0)
        value = mem.first().property("value").value().toString();
    return value;
}

function list(cmd) {
    if (cmd.length == 2 && cmd[1] === "json") {
        return listjson();
    }
    if (cmd.length != 1)
        return ["Error:", "This command has max 1 parameter 'json'"];
    var result = [];
    result[0] = "Result:";
    result[1] = field("Property Name", WIDTH_L, ' ') + "| " + field("Property Value", WIDTH_R, ' ');
    result[2] = field("", WIDTH_L + WIDTH_R + 2, '-');
    var i = 3;
    stream.memory("properties").forEach(function (msg) {
        result[i++] = field(msg.property("name").value().toString(), WIDTH_L, ' ') + "| " + field(msg.property("value").value().toString(), WIDTH_R, ' ');
    });
    return result;
}

function listjson() {
    var result = ["Result:"];
    var props = {};
    var i = 0;
    stream.memory("properties").forEach(function (msg) {
        props[msg.property("name").value().toString()] = msg.property("value").value().toString()
    });
    result[1] = JSON.stringify(props);
    return result;
}

function clearProperties(cmd) {
    var command = Util.cutFirst(cmd);
    if (command !== null)
        return ["Error:", "This command expects no parameters!"];
    stream.memory("properties").clear();
    return ["Result:", "All properties have been deleted."];
}

function help() {
    var s = shellCommands.slice();
    stream.memory("commands").forEach(function (msg) {
        var command = msg.property("command").value().toString();
        if (msg.property("shell").value().toBoolean())
            command += " <command>";
        s.push(field(command, WIDTH_L, ' ') + "| " + field(msg.property("description").value().toString(), WIDTH_R, ' '));
        if (!msg.property("shell").value().toBoolean()) {
            var parms = JSON.parse(msg.property("parameters").value().toString());
            parms.forEach(function (parm) {
                var skey = "<" + parm.name + ">";
                var cmd = "  " + (parm.mandatory ? skey : "[" + skey + "]");
                var description = parm.description;
                if (parm.validator){
                    switch (parm.validator.type){
                         case "choice":
                            description += ": "+Util.concat(parm.validator.values, " | ");
                            break;
                    }
                }
                s.push(field(cmd, WIDTH_L, ' ') + "| " + field("  " + description, WIDTH_R, ' '));
            });
        }
    });
    stream.memory("contexts").forEach(function (msg) {
        var command = msg.property("command").value().toString();
        s.push(field(command, WIDTH_L, ' ') + "| " + field(msg.property("description").value().toString(), WIDTH_R, ' '));
        s.push(field(" <command>", WIDTH_L, ' ') + "| " + field("  Shell commands", WIDTH_R, ' '));
    });
    return s;
}

function field(s, length, c) {
    var res = s;
    for (var i = s.length; i < length; i++)
        res += c;
    return res;
}

function validate(value, parm) {
    if (!parm.validator)
        return value;
    switch (parm.validator.type){
        case "integer":
            if (!INTEGER.test(value))
                throw "Value '"+value+"' is not an valid integer!";
            break;
        case "identifier":
            if (!IDENTIFIER.test(value))
                throw "Value '"+value+"' is not an valid identifier (digits, characters and _ are allowed)!";
            break;
        case "destination":
            if (!DESTINATION.test(value))
                throw "Value '"+value+"' is not a valid destination (digits, characters, _ . % $ are allowed)!";
            break;
        case "choice":
            var found = false;
            for (var i=0;i<parm.validator.values.length;i++) {
                if (value === parm.validator.values[i]) {
                    found = true;
                    break;
                }
            }
            if (!found)
                throw "Value '"+value+"' is invalid! Allowed are: "+JSON.stringify(parm.validator.values);
            break;
    }
    return value;
}

function fillParameters(cmd, parms) {
    var result = [];
    if (cmd.length === 1) {
        parms.forEach(function (parm) {
            var value = getProp(parm.name);
            if (parm.mandatory && value === "undefined")
                throw "Missing parameter: " + parm.name;
            result.push(value==="undefined"?"-":value);
        });
        return result;
    }
    if (cmd.length - 1 !== parms.length)
        throw "Invalid number of parameters for this command: " + cmd[0];
    for (var i = 1; i < cmd.length; i++) {
        if (cmd[i] === "$") {
            var value = getProp(parms[i - 1].name);
            if (value === "undefined")
                throw "Missing parameter: " + parms.name;
            result.push(validate(value, parms[i-1]));
        } else if (cmd[i] === "-") {
            if (parms[i - 1].mandatory)
                throw "Parameter '" + parms[i - 1].name + "' is mandatory!";
            result.push("-");
        } else {
            result.push(validate(cmd[i], parms[i-1]));
        }
    }
    return result;
}

function forwardCommand(cmd, cmdMsg) {
    var mem = stream.memory("commands").index("command").get(cmd[0]);
    if (mem.size() === 0) {
        mem = stream.memory("contexts").index("command").get(cmd[0]);
        if (mem.size() === 0)
            return ["Error:", "Unknown command: " + cmd[0]];
    }
    if (mem.first().property("shell").value().toBoolean()) {
        if (cmd.length === 1)
            return ["Error:", "Missing <command> parameter: " + cmd[0]];
        var oldRequest = JSON.parse(cmdMsg.body());
        oldRequest.command = oldRequest.command.substring(oldRequest.command.indexOf(" ") + 1);
        cmdMsg.body(JSON.stringify(oldRequest));
        stream.output(mem.first().property("streamname").value().toString()).send(cmdMsg);
    }
    else {
        try {
            var parms = JSON.parse(stream.memory("commands").index("command").get(cmd[0]).first().property("parameters").value().toString());
            var result = fillParameters(cmd, parms);
            cmdMsg.property("commandrequest").set(false).property("forward").set(true).property("command").set(cmd[0]).property("parameters").set(JSON.stringify(result));
            stream.output(streamname).send(cmdMsg);
        } catch (e) {
            return ["Error:", e];
        }
    }
    return null;
}

function sendInit(output, id) {
    var msg = {
        msgtype: "servicereply",
        streamname: streamname,
        eventtype: "init",
        body: {
            time: time.currentTime(),
            message: ["Welcome to " + stream.name() + "!",
                "Enter shell command or type 'help' to get a list of available commands."]
        }
    };
    output.send(
        stream.create().message()
            .textMessage()
            .correlationId(id)
            .property("streamdata").set(true)
            .property("streamname").set(streamname)
            .body(JSON.stringify(msg))
    );
}

function executeCommand(output, cmdMsg) {
    var msg = {
        msgtype: "servicereply",
        streamname: streamname,
        eventtype: "commandresult",
        body: {
            time: time.currentTime(),
            message: null
        }
    };
    var id = cmdMsg.correlationId();
    var request = JSON.parse(cmdMsg.body());
    try {
        var cmd = Util.parseCLICommand(request.command);
        var result;
        var handled = true;
        if (hasProps === "true") {
            switch (cmd[0]) {
                case "howto":
                    result = HOWTO;
                    break;
                case "help":
                    result = help();
                    break;
                case "set":
                    result = setProperty(cmd);
                    break;
                case "get":
                    result = getProperty(cmd);
                    break;
                case "list":
                    result = list(cmd);
                    break;
                case "clear":
                    result = clearProperties(cmd);
                    break;
                default:
                    result = forwardCommand(cmd, cmdMsg);
                    handled = result !== null;
                    break;
            }
        } else {
            switch (cmd[0]) {
                case "howto":
                    result = HOWTO;
                    break;
                case "help":
                    result = help();
                    break;
                default:
                    result = forwardCommand(cmd, cmdMsg);
                    handled = result !== null;
                    break;
            }
        }
    } catch (e) {
        handled = true;
        result = ["Error:", e.getMessage()];
    }
    if (handled) {
        msg.body.message = result;
        output.send(
            stream.create().message()
                .textMessage()
                .correlationId(id)
                .property("streamdata").set(true)
                .property("streamname").set(streamname)
                .body(JSON.stringify(msg))
        );
    }
}

// Stream Registry Stuff
stream.create().output(registryTopic).topic();

stream.onStart(function () {
    stream.output(registryTopic).send(
        stream.create()
            .message()
            .message()
            .property("registryrequest").set(true)
            .property("streamname").set(streamname)
            .property("streamtype").set("service")
            .property("available").set(true)
    );
    if (registerAtShells) {
        upperShells.forEach(function (shell) {
            stream.output(shell).send(
                stream.create().message().message()
                    .property("registryrequest").set(true)
                    .property("operation").set("add")
                    .property("streamname").set(streamname)
                    .property("command").set(registerAtShellsCommand)
                    .property("description").set(registerAtShellsDescription)
                    .property("shell").set(true)
            );
        });
    }
    if (mpQueue) {
        sendState("GREEN", monitorName+" active");
    }
});

stream.onStop(function () {
    stream.output(registryTopic).send(
        stream.create()
            .message()
            .message()
            .property("registryrequest").set(true)
            .property("streamname").set(streamname)
            .property("streamtype").set("service")
            .property("available").set(false)
    );
    if (registerAtShells) {
        upperShells.forEach(function (shell) {
            stream.output(shell).send(
                stream.create().message().message()
                    .property("registryrequest").set(true)
                    .property("operation").set("remove")
                    .property("command").set(registerAtShellsCommand)
                    .property("shell").set(true)
            );
        });
    }
    if (mpQueue) {
        sendState("YELLOW", monitorName+" inactive");
    }
});


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
