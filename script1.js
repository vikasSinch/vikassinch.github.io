document.addEventListener('DOMContentLoaded', function() {
    var input = document.getElementById('jsonInput');
    input.addEventListener('keydown', function(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            submitAndFormatPayload(input.value);
        }
    });
});

function submitAndFormatPayload(payload) {
    var payloadsList = document.getElementById('sentPayloads');

    try {
        var jsonObj = JSON.parse(payload);
        var formattedJson = JSON.stringify(jsonObj, null, 4);
        document.getElementById('jsonInput').value = formattedJson;
        sendPayload(formattedJson);
        displayPayload(formattedJson, payloadsList);
    } catch (jsonError) {
        try {
            var parser = new DOMParser();
            var xmlDoc = parser.parseFromString(payload, "text/xml");
            if (xmlDoc.getElementsByTagName("parsererror").length > 0) {
                throw new Error('Invalid XML');
            }
            var formattedXml = new XMLSerializer().serializeToString(xmlDoc);
            document.getElementById('jsonInput').value = formatXml(formattedXml);
            sendPayload(formattedXml);
            displayPayload(formattedXml, payloadsList);
        } catch (xmlError) {
            alert("Invalid JSON or XML");
        }
    }
}

function sendPayload(payload) {
    window.parent.postMessage(payload, "*"); // Replace '*' with your domain
    alert('Payload sent!');
}

function displayPayload(payload, listElement) {
    var timeNow = new Date().toLocaleString();
    var listItem = document.createElement('li');

    var editLink = document.createElement('button');
    editLink.textContent = 'Edit';
    editLink.style.marginLeft = '5px';
    editLink.onclick = function() {
        document.getElementById('jsonInput').value = payload; // Load the payload into the textarea for editing
    };

    
    var viewLink = document.createElement('span');
    viewLink.textContent = timeNow + ": Click to view...";
    viewLink.style.cursor = 'pointer';
    viewLink.onclick = function() {
        payloadContent.style.display = payloadContent.style.display === 'block' ? 'none' : 'block';
    };

    var submitLink = document.createElement('button');
    submitLink.textContent = 'Submit';
    submitLink.style.marginLeft = '10px';
    submitLink.onclick = function() {
        submitAndFormatPayload(payload);
    };

    var deleteLink = document.createElement('button');
    deleteLink.textContent = 'Delete';
    deleteLink.style.marginLeft = '5px';
    deleteLink.onclick = function() {
        listElement.removeChild(listItem);
    };

    var payloadContent = document.createElement('div');
    payloadContent.className = 'payload-content';
    payloadContent.textContent = payload;
    payloadContent.style.display = 'none';

  
    listItem.appendChild(viewLink);
    listItem.appendChild(editLink);
    listItem.appendChild(submitLink);
    listItem.appendChild(deleteLink);
    listItem.appendChild(payloadContent);
    listElement.appendChild(listItem);
}

function formatXml(xml) {
    var formatted = '';
    var reg = /(>)(<)(\/*)/g;
    xml = xml.replace(reg, '$1\r\n$2$3');
    var pad = 0;
    xml.split('\r\n').forEach(function(node) {
        var indent = 0;
        if (node.match(/.+<\/\w[^>]*>$/)) {
            indent = 0;
        } else if (node.match(/^<\/\w/)) {
            if (pad != 0) {
                pad -= 1;
            }
        } else if (node.match(/^<\w([^>]*[^\/])?>.*$/)) {
            indent = 1;
        } else {
            indent = 0;
        }

        var padding = '';
        for (var i = 0; i < pad; i++) {
            padding += '  ';
        }

        formatted += padding + node + '\r\n';
        pad += indent;
    });

    return formatted;
}
