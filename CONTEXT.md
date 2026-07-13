# Ablesci PDF Assistance

This context describes how the extension recognizes scholarly articles and obtains the correct full-text PDF for an Ablesci assistance request.

## Language

**Publisher PDF Capability**:
The publisher-specific knowledge needed to identify an article, discover its main full-text PDF, and determine whether a downloaded PDF belongs to that article. Browser navigation, download execution, retries, access challenges, and uploading are outside this concept.
_Avoid_: Publisher adapter, translator, downloader

**Article Identity**:
The publisher, canonical article location, and stable scholarly identifiers that together identify the article being assisted.
_Avoid_: Page URL, download URL

**PDF Candidate**:
A possible main full-text PDF associated with an Article Identity, together with the evidence describing where the candidate came from.
_Avoid_: PDF link, attachment

**Download Ownership**:
The decision about whether downloaded content belongs to the expected Article Identity, including a stable reason when ownership cannot be established.
_Avoid_: URL match, download success
