var shellTopic = parameters.require("shell-topic");
var streamname = "stream_" + stream.routerName() + "_metastreamregistry";
var topic = parameters.optional("topic", streamname);
var mpQueue = parameters.get("monitorpanel-queue");
var monitorName = stream.name();
var STREAMMETA_PARMS = [];

var REPLY = {
    msgtype: "servicereply",
    streamname: shellTopic,
    eventtype: "commandresult",
    body: {
        time: 0,
        message: null
    }
};

stream.create().input(shellTopic).topic().selector("forward = true and command in ('streammeta')").onInput(function (input) {
    var out = stream.create().output(null).forAddress(input.current().replyTo());
    executeCommand(out, input.current().correlationId(), input.current().property("command").value().toString(), JSON.parse(input.current().property("parameters").value().toString()));
    out.close();
});

// Registry Requests
stream.create().input("metaregistryrequest").topic().selector("registryrequest = true")
    .durable()
    .clientId("metaregistry")
    .durableName(stream.domainName())
    .destinationName(topic)
    .onInput(function (input) {
        var avail = input.current().property("available").value().toBoolean();
        if (avail) {
            stream.memory("registry").add(input.current());
        }
        else {
            stream.memory("registry").index("streamname").remove(input.current().property("streamname").value().toString());
        }
    });

stream.create().memory("registry").heap().createIndex("streamname");
stream.create().output(shellTopic).topic();
stream.create().output(mpQueue).queue();

function sendReply(msg, output, id) {
    msg.body.time = time.currentTime();
    stream.log().info(JSON.stringify(msg));
    output.send(
        stream.create().message()
            .textMessage()
            .correlationId(id)
            .property("streamdata").set(true)
            .property("streamname").set(shellTopic)
            .body(JSON.stringify(msg))
    );
}

function executeCommand(output, id, cmd, parms) {
    stream.log().info("executeCommand: " + cmd + ", parms=" + JSON.stringify(parms));
    var result;
    switch (cmd) {
        case "streammeta":
            result = streamMeta(parms);
            break;
        default:
            result = ["Error:", "Invalid command: " + cmd];
            break;
    }
    if (result !== null) {
        REPLY.body.message = result;
        sendReply(REPLY, output, id);
    }
}

function streamMeta(parms) {
    var result = [];
    stream.memory("registry").forEach(function (msg){
           result.push(JSON.parse(msg.body()));
    });
    return ["Result:", JSON.stringify(result)];
}


// Startup -> Monitor Panel
stream.onStart(function () {
    sendState("GREEN", monitorName + " active");
    stream.output(shellTopic).send(
        stream.create().message().message()
            .property("registryrequest").set(true)
            .property("operation").set("add")
            .property("command").set("streammeta")
            .property("description").set("Returns the meta data of dashboard streams")
            .property("parameters").set(JSON.stringify(STREAMMETA_PARMS))
    );
});

// Stopped -> Monitor Panel
stream.onStop(function () {
    sendState("YELLOW", monitorName + " inactive");
    stream.output(shellTopic).send(
        stream.create().message().message()
            .property("registryrequest").set(true)
            .property("operation").set("remove")
            .property("command").set("streammeta")
    );
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
