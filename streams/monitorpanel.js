var streamname = ("stream_" + stream.routerName() + "_" + stream.fullyQualifiedName()).replace(/\./g, "_").replace(/\./g, "_");
var registryTopic = parameters.optional("registry-topic", "stream_" + stream.routerName() + "_streamregistry");
var histSize = typeconvert.toInteger(parameters.optional("history-size", "10"));

var inputQueue = "streams_" + stream.fullyQualifiedName().replace(/\./g, "_") + "_input";
var storeQueue = "streams_" + stream.fullyQualifiedName().replace(/\./g, "_") + "_store";

// Create input and store queue if not exists
stream.cli().execute("cc /sys$queuemanager/queues")
    .exceptionOff()
    .execute("new " + inputQueue)
    .execute("new " + storeQueue);

stream.create().input(inputQueue).queue().onInput(function (input) {
    sendUpdate(stream.output(streamname), input.current());
    stream.memoryGroup("messages").add(input.current());
});

stream.create().memoryGroup("messages", "name").inactivityTimeout().days(1).onCreate(function (key) {
    stream.create().memory(key).sharedQueue(storeQueue).limit().count(histSize).limit().time().days(5);
    return stream.memory(key);
});

stream.create().timer("checklimit").interval().hours(1).onTimer(function (timer) {
    stream.memoryGroup("messages").checkLimit();
});

// Init Requests
stream.create().input(streamname).topic().selector("initrequest = true")
    .onInput(function (input) {
        var out = stream.create().output(null).forAddress(input.current().replyTo());
        sendInit(out);
        out.close();
    });

function sendInit(output) {
    var msg = {
        msgtype: "stream",
        streamname: streamname,
        eventtype: "init",
        body: {
            routername: stream.routerName(),
            histsize: histSize,
            time: time.currentTime(),
            values: {}
        }
    };
    stream.memoryGroup("messages").forEach(function (memory) {
        var entry = [];
        memory.reverse().forEach(function (message) {
            entry.push(JSON.parse(message.body()));
        });
        if (entry.length > 0)
            msg.body.values[memory.name()] = entry;
    });
    output.send(
        stream.create().message()
            .textMessage()
            .property("streamdata").set(true)
            .property("streamname").set(streamname)
            .body(JSON.stringify(msg))
    );
}

stream.create().output(streamname).topic();

function sendUpdate(output, message) {
    var msg = {
        msgtype: "stream",
        streamname: streamname,
        eventtype: "update",
        body: {
            routername: stream.routerName(),
            time: time.currentTime(),
            value: JSON.parse(message.body())
        }
    };
    output.send(
        stream.create().message()
            .textMessage()
            .property("streamdata").set(true)
            .property("streamname").set(streamname)
            .body(JSON.stringify(msg))
    );
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
            .property("streamtype").set("monitor")
            .property("available").set(true)
    );
});

stream.onStop(function () {
    stream.output(registryTopic).send(
        stream.create()
            .message()
            .message()
            .property("registryrequest").set(true)
            .property("streamname").set(streamname)
            .property("streamtype").set("monitor")
            .property("available").set(false)
    );
});
