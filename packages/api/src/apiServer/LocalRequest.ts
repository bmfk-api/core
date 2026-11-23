

/*axios.interceptors.request.use((x:InternalAxiosRequestConfig<any>)=>{
	console.log(`AXIOS REQ:\n\turl:${x.url}\n\tmethod: ${x.method}\n\tdata: ${(()=>{
		if(typeof x.data === "string" )
			return x.data

		return JSON.stringify(x.data,null,"\t\t");
	})()}\n\theaders:\n${(()=>{
		let h = "";
		for(let i in x.headers){
			if(h!=="")
				h+="\n"
			h+="\t\t"+i+" = "+x.headers[i]
		}
		return h
	})()}`)
	return x;
})

axios.interceptors.response.use((x:AxiosResponse)=>{
	console.log(`AXIOS RESP:\n\tdata: ${(()=>{
		if(typeof x.data === "string" )
			return x.data

		return JSON.stringify(x.data,null,"\t\t");
	})()}\n\theaders:\n${(()=>{
		let h = "";
		for(let i in x.headers){
			if(h!=="")
				h+="\n"
			h+="\t\t"+i+" = "+x.headers[i]
		}
		return h
	})()}`)
	return x;
})*/

export const LocalRequest = async (ep: string, data?: any, method?: string,headers?:{[key:string]:string}) => {
	/*let m = "get"
	if (method)
		m = method.toLowerCase();
	if (data && !method)
		m = "post"

	if (ep.startsWith("/"))
		ep = ep.substring(1)
	let url = "http://localhost:8091/" + ep;
	
	if (ep.toLowerCase().startsWith("http"))
		url = ep;

	let resp = null;
	console.log("open url: ", url)
	try {
		if (m === "get")
			resp = await axios.get(url,{headers:headers});
		if (m === "post")
			resp = await axios.post(url, data,{headers:headers})
	} catch (e) {
		console.log("ERROR! cant open url",e)
	}
	console.log(resp)*/
}
